import type { IconType } from 'react-icons';
import {
  LuArchive, LuCalendarClock, LuContainer, LuDatabase, LuInbox, LuKeyRound, LuMegaphone, LuPackage, LuScrollText, LuSplit,
  LuWaypoints, LuWorkflow, LuZap,
} from 'react-icons/lu';

export const SERVICE_ICONS: Record<string, IconType> = {
  lambda: LuZap,
  sqs: LuInbox,
  sns: LuMegaphone,
  s3: LuArchive,
  secrets: LuKeyRound,
  eventbridge: LuCalendarClock,
  stepfunctions: LuWorkflow,
  logs: LuScrollText,
  dynamodb: LuDatabase,
  ecs: LuContainer,
  apigateway: LuWaypoints,
  elb: LuSplit,
  ecr: LuPackage,
};
