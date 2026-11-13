
export interface ServiceInfo {
  id: string;
  name: string;
  short: string;
  href: string;
  description: string;
}

export const SERVICES: ServiceInfo[] = [
  { id: 'lambda', name: 'AWS Lambda', short: 'Lambda', href: '/lambda', description: 'Functions, invoke with payload, recent logs' },
  { id: 'sqs', name: 'Amazon SQS', short: 'SQS', href: '/sqs', description: 'Queues, send, receive, purge' },
  { id: 'sns', name: 'Amazon SNS', short: 'SNS', href: '/sns', description: 'Topics, subscriptions, publish' },
  { id: 's3', name: 'Amazon S3', short: 'S3', href: '/s3', description: 'Buckets and objects, upload and download' },
  { id: 'secrets', name: 'Secrets Manager', short: 'Secrets', href: '/secrets', description: 'Secrets, masked values, new versions' },
  {
    id: 'eventbridge', name: 'Amazon EventBridge', short: 'EventBridge', href: '/eventbridge', description: 'Buses, rules, targets, events and Scheduler',
  },
  { id: 'stepfunctions', name: 'Step Functions', short: 'Step Functions', href: '/stepfunctions', description: 'State machines, executions, history' },
  { id: 'logs', name: 'CloudWatch Logs', short: 'Logs', href: '/logs', description: 'Log groups, streams, tail events' },
  { id: 'dynamodb', name: 'Amazon DynamoDB', short: 'DynamoDB', href: '/dynamodb', description: 'Tables, scan, put and delete items' },
  { id: 'ecs', name: 'Amazon ECS', short: 'ECS', href: '/ecs', description: 'Clusters, services, tasks, task definitions' },
  {
    id: 'apigateway', name: 'API Gateway', short: 'API Gateway', href: '/apigateway', description: 'REST (v1) and HTTP (v2) APIs, routes, stages',
  },
  { id: 'elb', name: 'Elastic Load Balancing', short: 'Load Balancers', href: '/elb', description: 'ALBs, listeners, target groups, health' },
  { id: 'ecr', name: 'Amazon ECR', short: 'ECR', href: '/ecr', description: 'Repositories and images' },
];


export function serviceById(id: string) {
  return SERVICES.find((s) => s.id === id);
}
