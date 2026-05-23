import { z } from 'zod';

/** TLive canonical effort. Providers map these values to their native controls. */
export const canonicalEffortSchema = z.enum(['low', 'medium', 'high', 'max']);
export type EffortLevel = z.infer<typeof canonicalEffortSchema>;
