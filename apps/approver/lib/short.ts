/** 0x1234…abcd. Its own module so the page shell doesn't pull in format.ts (and with it zod via shared). */
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
