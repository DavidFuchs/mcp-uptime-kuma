import type { Scenario } from '../scenario.js';
import pauseAndTag from './pause-and-tag.js';
import createDnsMonitor from './create-dns-monitor.js';
import createKeywordMonitor from './create-keyword-monitor.js';
import createPushMonitor from './create-push-monitor.js';
import updateWithoutClobber from './update-without-clobber.js';
import maintenanceWithTimezone from './maintenance-with-timezone.js';
import notificationAttach from './notification-attach.js';
import ambiguousDelete from './ambiguous-delete.js';

export const scenarios: Scenario<any>[] = [
  pauseAndTag,
  createDnsMonitor,
  createKeywordMonitor,
  createPushMonitor,
  updateWithoutClobber,
  maintenanceWithTimezone,
  notificationAttach,
  ambiguousDelete,
];
