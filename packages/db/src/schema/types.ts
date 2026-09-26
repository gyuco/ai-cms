import { customType } from 'drizzle-orm/pg-core';

export const ltree = customType<{ data: string }>({ dataType: () => 'ltree' });
export const citext = customType<{ data: string }>({ dataType: () => 'citext' });
