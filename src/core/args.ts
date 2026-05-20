export interface FlagSpec {
  long: string;
  short?: string;
}

/** Command flags shared by command parsers. */
export const FLAGS = {
  ALL: { long: '--all', short: '-a' },
} as const;

/** Check if args contain a specific flag (long or short form, case-insensitive). */
export function hasFlag(args: string[], flag: FlagSpec): boolean {
  return args.some(arg => {
    const normalized = arg.toLowerCase();
    return normalized === flag.long || (flag.short !== undefined && normalized === flag.short);
  });
}

/** Get first argument that is not one of the specified flags (case-insensitive). */
export function getNonFlagArg(args: string[], flags: FlagSpec[]): string | undefined {
  return args.find(arg => {
    const normalized = arg.toLowerCase();
    return !flags.some(f => normalized === f.long || (f.short !== undefined && normalized === f.short));
  });
}
