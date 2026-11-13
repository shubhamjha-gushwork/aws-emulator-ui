import { describe, expect, it } from 'vitest';
import { rewriteSfn } from '@/lib/deploy/serverless/apply';

describe('rewriteSfn', () => {
  const fnArns = {
    CreateAirtableBase: 'arn:aws:lambda:us-east-1:000000000000:function:sample-api-local-CreateThing',
    ProcessCleanup: 'arn:aws:lambda:us-east-1:000000000000:function:sample-api-local-ProcessCleanup',
  };

  it('rewrites Fn::GetAtt Resources to Lambda ARNs but leaves StartAt/Next state names alone', () => {
    const def = {
      StartAt: 'CreateAirtableBase',
      States: {
        CreateAirtableBase: {
          Type: 'Task',
          Resource: { 'Fn::GetAtt': ['CreateAirtableBase', 'Arn'] },
          Next: 'ProcessCleanup',
        },
        ProcessCleanup: {
          Type: 'Task',
          Resource: { 'Fn::GetAtt': ['ProcessCleanup', 'Arn'] },
          End: true,
        },
      },
    };
    const out = rewriteSfn(def, fnArns, {}) as typeof def;
    expect(out.StartAt).toBe('CreateAirtableBase');
    expect(out.States.CreateAirtableBase.Next).toBe('ProcessCleanup');
    expect(out.States.CreateAirtableBase.Resource).toBe(fnArns.CreateAirtableBase);
    expect(out.States.ProcessCleanup.Resource).toBe(fnArns.ProcessCleanup);
  });

  it('rewrites Parameters.FunctionName GetAtt for lambda:invoke integrations', () => {
    const def = {
      StartAt: 'SubmitScrapeJob',
      States: {
        SubmitScrapeJob: {
          Type: 'Task',
          Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
          Parameters: { FunctionName: { 'Fn::GetAtt': ['CreateAirtableBase', 'Arn'] } },
          Next: 'ProcessCleanup',
        },
        ProcessCleanup: { Type: 'Succeed' },
      },
    };
    const out = rewriteSfn(def, fnArns, {}) as typeof def;
    expect(out.StartAt).toBe('SubmitScrapeJob');
    expect(out.States.SubmitScrapeJob.Next).toBe('ProcessCleanup');
    expect(out.States.SubmitScrapeJob.Resource).toBe('arn:aws:states:::lambda:invoke.waitForTaskToken');
    expect(out.States.SubmitScrapeJob.Parameters.FunctionName).toBe(fnArns.CreateAirtableBase);
  });
});
