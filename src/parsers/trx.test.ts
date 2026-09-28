import fs from 'fs';
import os from 'os';
import path from 'path';
import parseTrx from './trx';

const writeLargeTrx = (testCount: number): string => {
  const results: string[] = [];
  const definitions: string[] = [];

  for (let i = 0; i < testCount; i++) {
    const className = `Example.Tests.Class${i % 500}Tests`;
    const name = `${className}.Method${i}`;
    const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    const executionId = `11111111-0000-0000-0000-${String(i).padStart(12, '0')}`;

    results.push(
      `<UnitTestResult executionId="${executionId}" testId="${id}" testName="${name}" computerName="c" duration="00:00:00.001" startTime="2026-01-01T00:00:00Z" endTime="2026-01-01T00:00:00Z" testType="13cdc9d9-ddb5-4fa4-a97d-d965ccfc6d4b" outcome="Passed" testListId="x" />`
    );
    definitions.push(
      `<UnitTest name="${name}" storage="s.dll" id="${id}"><Execution id="${executionId}" /><TestMethod codeBase="s.dll" adapterTypeName="a" className="${className}" name="Method${i}" /></UnitTest>`
    );
  }

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TestRun id="r" name="r" runUser="u" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">',
    '<Times creation="2026-01-01T00:00:00Z" queuing="2026-01-01T00:00:00Z" start="2026-01-01T00:00:00Z" finish="2026-01-01T00:01:00Z" />',
    `<Results>${results.join('')}</Results>`,
    `<TestDefinitions>${definitions.join('')}</TestDefinitions>`,
    `<ResultSummary outcome="Completed"><Counters total="${testCount}" executed="${testCount}" passed="${testCount}" failed="0" /></ResultSummary>`,
    '</TestRun>'
  ].join('');

  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trx-scale-')), 'large.trx');
  fs.writeFileSync(filePath, xml);

  return filePath;
};

describe('trx parser', () => {
  it('parses failed test error details from standard trx', async () => {
    const filePath = path.resolve(__dirname, '../../files/fail/test_result.trx');
    const result = await parseTrx(filePath);

    expect(result).not.toBeNull();

    const failedTests = result!.suits.flatMap(suit => suit.tests).filter(test => test.outcome === 'Failed');

    expect(failedTests.length).toBeGreaterThan(0);
    expect(failedTests.some(test => test.error.length > 0)).toBe(true);
  });

  it('parses and flattens nested DataRow results from inner results', async () => {
    const filePath = path.resolve(__dirname, '../../files/fail/test_result_datarow.trx');
    const result = await parseTrx(filePath);

    expect(result).not.toBeNull();

    const allTests = result!.suits.flatMap(suit => suit.tests);

    // Should find both parent and inner result
    expect(allTests.length).toBe(2);

    // Find the parameterized inner result with error details
    const innerTest = allTests.find(t => t.name.includes('(addDays:'));
    expect(innerTest).toBeDefined();
    expect(innerTest!.outcome).toBe('Failed');
    expect(innerTest!.error).toContain('Assert.AreEqual failed');
    expect(innerTest!.trace).toContain('OTARunnerTests.cs:line 42');
  });

  it('parses failed DataRow message from inner results', async () => {
    const filePath = path.resolve(__dirname, '../../files/fail/test_result_datarow.trx');
    const result = await parseTrx(filePath);

    expect(result).not.toBeNull();

    const suit = result!.suits.find(s => s.name === 'Example.Tests.OTARunnerTests');
    expect(suit).toBeDefined();

    // Find the parameterized row with the error details
    const test = suit!.tests.find(t => t.name.includes('(addDays:'));
    expect(test).toBeDefined();
    expect(test!.outcome).toBe('Failed');
    expect(test!.error).toContain('Assert.AreEqual failed');
    expect(test!.trace).toContain('OTARunnerTests.cs:line 42');
  });

  it('prefers row-level DataRow failure details when testId is shared', async () => {
    const filePath = path.resolve(__dirname, '../../files/fail/test_result_datarow_shared_testid.trx');
    const result = await parseTrx(filePath);

    expect(result).not.toBeNull();

    const suit = result!.suits.find(s => s.name === 'Example.Tests.OTARunnerTests');
    expect(suit).toBeDefined();

    // The parameterized row should have the row-level error details
    const test = suit!.tests.find(t => t.name.includes('(addDays:'));
    expect(test).toBeDefined();
    expect(test!.outcome).toBe('Failed');
    expect(test!.error).toContain('DataRow shared-id mismatch');
    expect(test!.trace).toContain('OTARunnerTests.cs:line 55');
  });
  // Matching results to definitions used to be a full scan per definition, which made the
  // 24k-test run in Levitate-API's CI take ~81s. At 20k tests the indexed parse measures
  // ~0.4s against ~13.4s for the scan, so this budget clears the fix by better than 10x
  // while still failing well before the scan's floor - on a runner slow enough to push the
  // indexed parse to 6s, the scan would need three minutes.
  //
  // The parse blocks the event loop, so Jest's own timeout cannot fire during it; the
  // explicit timeout below only keeps Jest from reaping the test before this assertion runs.
  it('parses a large run without quadratic slowdown', async () => {
    const filePath = writeLargeTrx(20000);

    const start = Date.now();
    const result = await parseTrx(filePath);
    const elapsed = Date.now() - start;

    expect(result).not.toBeNull();
    expect(result!.suits.flatMap(suit => suit.tests)).toHaveLength(20000);
    expect(elapsed).toBeLessThan(6000);
  }, 120000);
});
