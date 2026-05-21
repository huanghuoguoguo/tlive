/** Shared type definitions used across multiple modules */

/** Todo item status from TodoWrite tool */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** TLive canonical effort. Providers map `max` to their native highest effort. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
