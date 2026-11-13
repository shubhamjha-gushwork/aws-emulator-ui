import type { ServiceModule } from './types';
import { lambda } from './lambda';
import { sqs } from './sqs';
import { sns } from './sns';
import { s3 } from './s3';
import { secrets } from './secrets';
import { eventbridge } from './eventbridge';
import { stepfunctions } from './stepfunctions';
import { logs } from './logs';
import { dynamodb } from './dynamodb';
import { ecs } from './ecs';
import { apigateway } from './apigateway';
import { elb } from './elb';
import { ecr } from './ecr';

export const services: Record<string, ServiceModule> = {
  lambda, sqs, sns, s3, secrets, eventbridge, stepfunctions, logs, dynamodb, ecs, apigateway, elb, ecr,
};
