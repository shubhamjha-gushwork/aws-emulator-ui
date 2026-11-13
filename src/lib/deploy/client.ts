import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ECRClient } from '@aws-sdk/client-ecr';
import { ECSClient } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SFNClient } from '@aws-sdk/client-sfn';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import http from 'http';
import https from 'https';
import type { DeployOptions } from './types';
import { DEPLOY_TAG } from './types';

export interface DeployClients {
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  requestHandler: NodeHttpHandler;
  lambda: LambdaClient;
  sqs: SQSClient;
  sns: SNSClient;
  s3: S3Client;
  ddb: DynamoDBClient;
  secrets: SecretsManagerClient;
  logs: CloudWatchLogsClient;
  events: EventBridgeClient;
  scheduler: SchedulerClient;
  apigw: APIGatewayClient;
  apigw2: ApiGatewayV2Client;
  sfn: SFNClient;
  ecs: ECSClient;
  ecr: ECRClient;
  elbv2: ElasticLoadBalancingV2Client;
}

export function makeClients(opts: Pick<DeployOptions, 'endpoint' | 'region'>): DeployClients {
  const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
  const requestHandler = new NodeHttpHandler({
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
    connectionTimeout: 8000,
    requestTimeout: 180000,
  });
  const base = { endpoint: opts.endpoint, region: opts.region, credentials, requestHandler, maxAttempts: 1 as const };
  return {
    endpoint: opts.endpoint,
    region: opts.region,
    credentials,
    requestHandler,
    lambda: new LambdaClient(base),
    sqs: new SQSClient(base),
    sns: new SNSClient(base),
    s3: new S3Client(base),
    ddb: new DynamoDBClient(base),
    secrets: new SecretsManagerClient(base),
    logs: new CloudWatchLogsClient(base),
    events: new EventBridgeClient(base),
    scheduler: new SchedulerClient(base),
    apigw: new APIGatewayClient(base),
    apigw2: new ApiGatewayV2Client(base),
    sfn: new SFNClient(base),
    ecs: new ECSClient(base),
    ecr: new ECRClient(base),
    elbv2: new ElasticLoadBalancingV2Client(base),
  };
}

export function resourceTags(opts: { id: string; stage: string; kind: string; service: string; source: string }): Record<string, string> {
  return {
    [DEPLOY_TAG.deploy]: opts.id,
    [DEPLOY_TAG.stage]: opts.stage,
    [DEPLOY_TAG.kind]: opts.kind,
    [DEPLOY_TAG.service]: opts.service,
    [DEPLOY_TAG.source]: opts.source.slice(-128),
  };
}

export function tagList(tags: Record<string, string>): { Key: string; Value: string }[] {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}
