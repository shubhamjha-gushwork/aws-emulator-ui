
export interface ServiceInfo {
  id: string;
  name: string;
  short: string;
  href: string;
  description: string;
  /** One plain sentence for the page header. */
  tagline: string;
}

export const SERVICES: ServiceInfo[] = [
  { id: 'lambda', name: 'AWS Lambda', short: 'Lambda', href: '/lambda', description: 'Functions, invoke with payload, recent logs', tagline: 'Create functions, invoke them with a test event, and read their logs.' },
  { id: 'sqs', name: 'Amazon SQS', short: 'SQS', href: '/sqs', description: 'Queues, send, receive, purge', tagline: 'Create queues, send and receive messages, and purge them.' },
  { id: 'sns', name: 'Amazon SNS', short: 'SNS', href: '/sns', description: 'Topics, subscriptions, publish', tagline: 'Create topics, manage subscriptions, and publish messages.' },
  { id: 's3', name: 'Amazon S3', short: 'S3', href: '/s3', description: 'Buckets and objects, upload and download', tagline: 'Create buckets, browse objects, and upload or download files.' },
  { id: 'secrets', name: 'Secrets Manager', short: 'Secrets', href: '/secrets', description: 'Secrets, masked values, new versions', tagline: 'Store secrets, reveal values when needed, and add new versions.' },
  {
    id: 'eventbridge', name: 'Amazon EventBridge', short: 'EventBridge', href: '/eventbridge', description: 'Buses, rules, targets, events and Scheduler', tagline: 'Route events with rules and targets, and run schedules.',
  },
  { id: 'stepfunctions', name: 'Step Functions', short: 'Step Functions', href: '/stepfunctions', description: 'State machines, executions, history', tagline: 'Build state machines, run executions, and inspect their history.' },
  { id: 'logs', name: 'CloudWatch Logs', short: 'Logs', href: '/logs', description: 'Log groups, streams, tail events', tagline: 'Browse log groups, and search and follow their events.' },
  { id: 'dynamodb', name: 'Amazon DynamoDB', short: 'DynamoDB', href: '/dynamodb', description: 'Tables, scan, put and delete items', tagline: 'Create tables, and scan, add, or delete items.' },
  { id: 'ecs', name: 'Amazon ECS', short: 'ECS', href: '/ecs', description: 'Clusters, services, tasks, task definitions', tagline: 'Run containers as tasks and services on clusters.' },
  {
    id: 'apigateway', name: 'API Gateway', short: 'API Gateway', href: '/apigateway', description: 'REST (v1) and HTTP (v2) APIs, routes, stages', tagline: 'Build REST and HTTP APIs, and test them.',
  },
  { id: 'elb', name: 'Elastic Load Balancing', short: 'Load Balancers', href: '/elb', description: 'ALBs, listeners, target groups, health', tagline: 'Manage load balancers, listeners, and target groups.' },
  { id: 'ecr', name: 'Amazon ECR', short: 'ECR', href: '/ecr', description: 'Repositories and images', tagline: 'Store container images in private repositories.' },
];


export function serviceById(id: string) {
  return SERVICES.find((s) => s.id === id);
}
