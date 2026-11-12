import type { Scenario } from '../scenario.js';
import pauseAndTag from './pause-and-tag.js';
import createDnsMonitor from './create-dns-monitor.js';
import createKeywordMonitor from './create-keyword-monitor.js';
import createPushMonitor from './create-push-monitor.js';

export const scenarios: Scenario<any>[] = [
  pauseAndTag,
  createDnsMonitor,
  createKeywordMonitor,
  createPushMonitor,
];
