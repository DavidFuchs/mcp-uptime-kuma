import type { Scenario } from '../scenario.js';
import pauseAndTag from './pause-and-tag.js';
import createDnsMonitor from './create-dns-monitor.js';
import createKeywordMonitor from './create-keyword-monitor.js';
import createPushMonitor from './create-push-monitor.js';
import updateWithoutClobber from './update-without-clobber.js';
import maintenanceWithTimezone from './maintenance-with-timezone.js';
import notificationAttach from './notification-attach.js';
import ambiguousDelete from './ambiguous-delete.js';
import httpBasicAuth from './http-basic-auth.js';
import httpOauth from './http-oauth.js';
import httpPostHeaders from './http-post-headers.js';
import mqttMonitor from './mqtt-monitor.js';
import snmpMonitor from './snmp-monitor.js';
import radiusMonitor from './radius-monitor.js';
import gamedigMonitor from './gamedig-monitor.js';
import dnsCondition from './dns-condition.js';
import typeChangeKeyword from './type-change-keyword.js';
import groupsNested from './groups-nested.js';
import tagWithValue from './tag-with-value.js';
import statusPageGroups from './status-page-groups.js';
import dockerContainer from './docker-container.js';
import maintenanceEdit from './maintenance-edit.js';
import maintenanceRecurring from './maintenance-recurring.js';

export const scenarios: Scenario<any>[] = [
  pauseAndTag,
  createDnsMonitor,
  createKeywordMonitor,
  createPushMonitor,
  updateWithoutClobber,
  maintenanceWithTimezone,
  notificationAttach,
  ambiguousDelete,
  httpBasicAuth,
  httpOauth,
  httpPostHeaders,
  mqttMonitor,
  snmpMonitor,
  radiusMonitor,
  gamedigMonitor,
  dnsCondition,
  typeChangeKeyword,
  groupsNested,
  tagWithValue,
  statusPageGroups,
  dockerContainer,
  maintenanceEdit,
  maintenanceRecurring,
];
