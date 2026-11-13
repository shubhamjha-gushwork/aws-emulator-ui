import { IAMClient, GetRoleCommand, CreateRoleCommand, UpdateAssumeRolePolicyCommand, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { type Ctx, DEFAULT_ROLE_ARN } from './types';

export const HELPER_ROLE_NAME = 'aws-emulator-ui-role';

const TRUST = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow',
    Principal: { Service: ['lambda.amazonaws.com', 'scheduler.amazonaws.com', 'states.amazonaws.com', 'events.amazonaws.com', 'ecs-tasks.amazonaws.com'] },
    Action: 'sts:AssumeRole',
  }],
});

/**
 * What the helper role may do. AWS Emulator evaluates IAM for some cross-service steps (e.g. the ECS image pull
 * is made as the task execution role and ECR checks ecr:BatchGetImage), so the role carries the usual
 * task-execution permissions plus what the Step Functions / Scheduler / EventBridge targets need.
 */
const PERMISSIONS = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow',
    Action: [
      'ecr:GetAuthorizationToken', 'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage',
      'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents',
      'lambda:InvokeFunction', 'sqs:SendMessage', 'sns:Publish', 'states:StartExecution',
      'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query',
      'events:PutEvents', 'iam:PassRole',
    ],
    Resource: '*',
  }],
});

let ensured: Promise<string> | null = null;

/** Create (or repair) the UI's helper role once per server process; returns its ARN. IAM is global. */
export function ensureHelperRole(ctx: Ctx): Promise<string> {
  ensured ??= (async () => {
    const iam = ctx.client(IAMClient);
    try {
      await iam.send(new GetRoleCommand({ RoleName: HELPER_ROLE_NAME }));
      await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: HELPER_ROLE_NAME, PolicyDocument: TRUST }));
    } catch (e) {
      if ((e as Error).name !== 'NoSuchEntityException') throw e;
      await iam.send(new CreateRoleCommand({ RoleName: HELPER_ROLE_NAME, AssumeRolePolicyDocument: TRUST, Description: 'Created by AWS Emulator' }));
    }
    await iam.send(new PutRolePolicyCommand({ RoleName: HELPER_ROLE_NAME, PolicyName: 'aws-emulator-ui', PolicyDocument: PERMISSIONS }));
    return DEFAULT_ROLE_ARN;
  })().catch((e) => {
    ensured = null; // retry next time (e.g. emulator restarted)
    throw e;
  });
  return ensured;
}

/** The role ARN to use: the caller's, or the helper role (made sure to exist). */
export async function roleOrHelper(ctx: Ctx, roleArn: string | undefined) {
  if (roleArn && roleArn !== DEFAULT_ROLE_ARN) return roleArn;
  return ensureHelperRole(ctx);
}
