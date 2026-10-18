/** Delivery policy is transport metadata, not a change to the event contract. */
import {Rejected} from './contracts.ts';
export type NotificationMode='standard'|'overview_only';
export function notificationMode(value:unknown='standard'):NotificationMode {
 if(value!=='standard'&&value!=='overview_only')throw new Rejected('invalid_notification_mode');
 return value;
}
