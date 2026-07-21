import { processTestResults } from './results';
import { processTestCoverage } from './coverage';
import { getInputs, publishComment, setFailed, setSummary, createTestStatusCheck, log } from './utils';
import {
  formatChangedFileCoverageMarkdown,
  formatCoverageMarkdown,
  formatResultMarkdown
} from './formatting/markdown';
import { formatCoverageHtml, formatResultHtml, formatTitleHtml } from './formatting/html';
import { ICoverage } from './data';
import { DefaultArtifactClient } from '@actions/artifact';
import { writeFileSync } from 'fs';

const publishChangedFileCoverage = async (
  coverage: ICoverage,
  token: string,
  serverUrl: string,
  postNewComment: boolean
) => {
  for (const module of coverage.modules) {
    const changedFiles = module.files.filter(f => f.changedLinesTotal > 0);
    const commentTitle = `${module.name}'s Changed File Coverage`;

    if (changedFiles.length) {
      const message = formatChangedFileCoverageMarkdown(changedFiles);
      await publishComment(token, serverUrl, commentTitle, message, postNewComment);
    }
  }
};

const run = async (): Promise<void> => {
  try {
    const {
      token,
      title,
      resultsPath,
      coveragePath,
      coverageType,
      coverageThreshold,
      postNewComment,
      allowFailedTests,
      changedFiles,
      showFailedTestsOnly,
      showTestOutput,
      serverUrl,
      pullRequestCheck,
      pullRequestCheckName
    } = getInputs();

    let comment = '';
    let summary = formatTitleHtml(title);

    const testResult = await processTestResults(resultsPath, allowFailedTests);
    const resultHtml = formatResultHtml(testResult, showFailedTestsOnly, showTestOutput);
    comment += formatResultMarkdown(testResult);
    summary += resultHtml;

    if (coveragePath) {
      const testCoverage = await processTestCoverage(
        coveragePath,
        coverageType,
        coverageThreshold,
        changedFiles
      );

      comment += testCoverage ? formatCoverageMarkdown(testCoverage, coverageThreshold) : '';
      summary += testCoverage ? formatCoverageHtml(testCoverage) : '';

      if (testCoverage) {
        await publishChangedFileCoverage(testCoverage, token, serverUrl, postNewComment);
      }
    }

    // The GitHub step summary is capped at 1024 KB; a large test/coverage report
    // exceeds it and fails the step. Past the cap, upload the summary as an
    // artifact instead. Workaround from bibipkins/dotnet-test-reporter#53
    // (still unmerged upstream) — the reason this fork exists.
    const summaryKb = new Blob([summary]).size / 1024;

    if (summaryKb > 1024) {
      log('Summary exceeds the 1024 KB step-summary limit; uploading as testResults.md artifact instead');
      writeFileSync('testResults.md', summary);
      const artifactClient = new DefaultArtifactClient();
      await artifactClient.uploadArtifact('testResults', ['testResults.md'], '.', { retentionDays: 2 });
    } else {
      await setSummary(summary);
    }

    await publishComment(token, serverUrl, title, comment, postNewComment);

    if (pullRequestCheck) {
      await createTestStatusCheck(token, testResult.success, resultHtml, pullRequestCheckName);
    }
  } catch (error) {
    setFailed((error as Error).message);
  }
};

run();
