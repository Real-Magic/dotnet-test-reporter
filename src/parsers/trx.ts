import { ITestSuit, ResultParser, TestOutcome } from '../data';
import { readXmlFile } from '../utils';
import { TrxFile } from '../data/trx';

const parseTrx: ResultParser = async (filePath: string) => {
  const file = await readXmlFile<TrxFile>(filePath);

  if (!file) {
    return null;
  }

  const { start, finish } = parseElapsedTime(file);
  const summary = parseSummary(file);
  const suits = parseSuits(file);

  const elapsed = finish.getTime() - start.getTime();
  const skipped = summary.total - summary.executed;
  const success = summary.failed === 0;

  return { success, ...summary, skipped, elapsed, suits };
};

const parseElapsedTime = (file: TrxFile) => {
  const times = file.TestRun.Times[0]['$'];
  const start = new Date(times.start);
  const finish = new Date(times.finish);

  return { start, finish };
};

const parseSummary = (file: TrxFile) => {
  const summary = file.TestRun.ResultSummary[0];
  const counters = summary.Counters[0]['$'];

  return {
    outcome: String(summary['$'].outcome),
    total: Number(counters.total),
    passed: Number(counters.passed),
    failed: Number(counters.failed),
    executed: Number(counters.executed)
  };
};

const parseResults = (file: TrxFile) => {
  const results = file.TestRun?.Results?.[0]?.UnitTestResult ?? [];

  const parseResult = (result: (typeof results)[number]): ReturnType<typeof mapResult>[] => {
    const mappedResult = mapResult(result);
    const innerResults = result.InnerResults?.[0]?.UnitTestResult ?? [];

    return [mappedResult, ...innerResults.flatMap(parseResult)];
  };

  const mapResult = (result: (typeof results)[number]) => {
    const attributes = result['$'];

    return {
      executionId: attributes.executionId ? String(attributes.executionId) : '',
      testId: attributes.testId ? String(attributes.testId) : '',
      testName: attributes.testName ? String(attributes.testName) : '',
      testType: attributes.testType ? String(attributes.testType) : '',
      testListId: attributes.testListId ? String(attributes.testListId) : '',
      computerName: attributes.computerName ? String(attributes.computerName) : '',
      duration: attributes.duration ? String(attributes.duration) : '',
      startTime: new Date(attributes.startTime ?? ''),
      endTime: new Date(attributes.endTime ?? ''),
      outcome: String(attributes.outcome) as TestOutcome,
      output: String(result.Output?.[0]?.StdOut?.[0] ?? ''),
      error: String(result.Output?.[0]?.ErrorInfo?.[0]?.Message?.[0] ?? ''),
      trace: String(result.Output?.[0]?.ErrorInfo?.[0]?.StackTrace?.[0] ?? ''),
      relativeResultsDirectory: String(attributes.relativeResultsDirectory ?? '')
    };
  };

  return results.flatMap(parseResult);
};

const parseDefinitions = (file: TrxFile) => {
  const definitions = file.TestRun?.TestDefinitions?.[0]?.UnitTest ?? [];

  return definitions.map(definition => ({
    id: String(definition['$'].id),
    name: String(definition['$'].name),
    storage: String(definition['$'].storage),
    description: String(definition.Description?.[0]),
    executionId: String(definition.Execution[0]['$'].id),
    testMethod: {
      codeBase: String(definition.TestMethod[0]['$'].codeBase),
      adapterTypeName: String(definition.TestMethod[0]['$'].adapterTypeName),
      className: String(definition.TestMethod[0]['$'].className),
      name: String(definition.TestMethod[0]['$'].name)
    }
  }));
};

const indexResults = (results: ReturnType<typeof parseResults>) => {
  const byTestId = new Map<string, number[]>();
  const byExecutionId = new Map<string, number[]>();
  const byTestName = new Map<string, number[]>();
  const byParameterizedName = new Map<string, number[]>();

  const add = (index: Map<string, number[]>, key: string, position: number) => {
    const positions = index.get(key);

    if (positions) {
      positions.push(position);
    } else {
      index.set(key, [position]);
    }
  };

  results.forEach((result, position) => {
    add(byTestId, result.testId, position);
    add(byExecutionId, result.executionId, position);
    add(byTestName, result.testName, position);

    // A parameterized result is named `<definition name>(<arguments>)`, and the arguments
    // themselves can contain parentheses, so every prefix ending at a '(' is a definition
    // name this result could belong to.
    for (let i = result.testName.indexOf('('); i !== -1; i = result.testName.indexOf('(', i + 1)) {
      add(byParameterizedName, result.testName.slice(0, i), position);
    }
  });

  return { byTestId, byExecutionId, byTestName, byParameterizedName };
};

const findAllResultsForDefinition = (
  results: ReturnType<typeof parseResults>,
  index: ReturnType<typeof indexResults>,
  definition: ReturnType<typeof parseDefinitions>[number]
) => {
  const positions = new Set<number>();

  const candidates = [
    index.byTestId.get(definition.id),
    index.byExecutionId.get(definition.executionId),
    index.byTestName.get(definition.name),
    index.byParameterizedName.get(definition.name)
  ];

  for (const candidate of candidates) {
    candidate?.forEach(position => positions.add(position));
  }

  // Restore the original document order a linear scan would have produced, so which
  // definition claims a shared result stays deterministic.
  return [...positions].sort((a, b) => a - b).map(position => results[position]);
};

const parseSuits = (file: TrxFile) => {
  const suits: ITestSuit[] = [];
  const suitsByName = new Map<string, ITestSuit>();
  const results = parseResults(file);
  const index = indexResults(results);
  const definitions = parseDefinitions(file);
  const sortedDefinitions = definitions.sort((a, b) => a.name.localeCompare(b.name));
  const processedResults = new Set<string>();

  for (const definition of sortedDefinitions) {
    const matchingResults = findAllResultsForDefinition(results, index, definition);
    const existingSuit = suitsByName.get(definition.testMethod.className);
    const suit = existingSuit || {
      name: definition.testMethod.className,
      success: false,
      passed: 0,
      tests: []
    };

    for (const result of matchingResults) {
      const resultKey = `${result.testId}-${result.executionId}`;

      if (!processedResults.has(resultKey)) {
        processedResults.add(resultKey);

        suit.tests.push({
          name: result.testName.replace(`${definition.testMethod.className}.`, ''),
          output: result.output,
          error: result.error,
          trace: result.trace,
          outcome: result.outcome
        });
      }
    }

    if (!existingSuit) {
      suitsByName.set(suit.name, suit);
      suits.push(suit);
    }
  }

  suits.forEach(suit => {
    suit.success = suit.tests.every(test => test.outcome !== 'Failed');
    suit.passed = suit.tests.filter(test => test.outcome === 'Passed').length;
  });

  return suits;
};

export default parseTrx;
