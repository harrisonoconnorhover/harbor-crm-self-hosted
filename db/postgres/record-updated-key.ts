import {sql,type SQLWrapper} from 'drizzle-orm';

// The public cursor has millisecond precision. UTC makes the same sort key indexable in every session.
export const recordUpdatedKey=(value:SQLWrapper)=>sql`date_trunc('milliseconds',${value} AT TIME ZONE 'UTC')`;
