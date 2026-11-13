import fidelity from './fidelity.json';

export interface ServiceInfo {
  id: string;
  name: string;
  short: string;
  href: string;
  description: string;
  /** keys into fidelity.json (one service page can cover two AWS APIs) */
  fidelityKeys: { key: string; label: string }[];
}

export const SERVICES: ServiceInfo[] = [
  { id: 'lambda', name: 'AWS Lambda', short: 'Lambda', href: '/lambda', description: 'Functions, invoke with payload, recent logs', fidelityKeys: [{ key: 'lambda', label: 'Lambda' }] },
  { id: 'sqs', name: 'Amazon SQS', short: 'SQS', href: '/sqs', description: 'Queues, send, receive, purge', fidelityKeys: [{ key: 'sqs', label: 'SQS' }] },
  { id: 'sns', name: 'Amazon SNS', short: 'SNS', href: '/sns', description: 'Topics, subscriptions, publish', fidelityKeys: [{ key: 'sns', label: 'SNS' }] },
  { id: 's3', name: 'Amazon S3', short: 'S3', href: '/s3', description: 'Buckets and objects, upload and download', fidelityKeys: [{ key: 's3', label: 'S3' }] },
  { id: 'secrets', name: 'Secrets Manager', short: 'Secrets', href: '/secrets', description: 'Secrets, masked values, new versions', fidelityKeys: [{ key: 'secretsmanager', label: 'Secrets Manager' }] },
  {
    id: 'eventbridge', name: 'Amazon EventBridge', short: 'EventBridge', href: '/eventbridge', description: 'Buses, rules, targets, events and Scheduler',
    fidelityKeys: [{ key: 'eventbridge', label: 'Events' }, { key: 'scheduler', label: 'Scheduler' }],
  },
  { id: 'stepfunctions', name: 'Step Functions', short: 'Step Functions', href: '/stepfunctions', description: 'State machines, executions, history', fidelityKeys: [{ key: 'sfn', label: 'Step Functions' }] },
  { id: 'logs', name: 'CloudWatch Logs', short: 'Logs', href: '/logs', description: 'Log groups, streams, tail events', fidelityKeys: [{ key: 'logs', label: 'Logs' }] },
  { id: 'dynamodb', name: 'Amazon DynamoDB', short: 'DynamoDB', href: '/dynamodb', description: 'Tables, scan, put and delete items', fidelityKeys: [{ key: 'dynamodb', label: 'DynamoDB' }] },
  { id: 'ecs', name: 'Amazon ECS', short: 'ECS', href: '/ecs', description: 'Clusters, services, tasks, task definitions', fidelityKeys: [{ key: 'ecs', label: 'ECS' }] },
  {
    id: 'apigateway', name: 'API Gateway', short: 'API Gateway', href: '/apigateway', description: 'REST (v1) and HTTP (v2) APIs, routes, stages',
    fidelityKeys: [{ key: 'apigateway', label: 'REST v1' }, { key: 'apigatewayv2', label: 'HTTP v2' }],
  },
  { id: 'elb', name: 'Elastic Load Balancing', short: 'Load Balancers', href: '/elb', description: 'ALBs, listeners, target groups, health', fidelityKeys: [{ key: 'elbv2', label: 'ELBv2' }] },
  { id: 'ecr', name: 'Amazon ECR', short: 'ECR', href: '/ecr', description: 'Repositories and images', fidelityKeys: [{ key: 'ecr', label: 'ECR' }] },
];

export type FidelityScore = { pass: number; total: number; pct: number | null };
export const FIDELITY = fidelity as { release: string; scoredAt: string; scores: Record<string, FidelityScore> };

export function serviceById(id: string) {
  return SERVICES.find((s) => s.id === id);
}
