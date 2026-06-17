import pino from 'pino';
import { INSTANCE_ID } from './realtime/instance.js';

export const logger = pino({ level: process.env.LOG_LEVEL || 'info' }).child({
  instanceId: INSTANCE_ID,
});
