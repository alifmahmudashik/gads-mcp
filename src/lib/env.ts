export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. Add it in Vercel -> Settings -> Environment Variables.`);
  return v;
}
export const opt = (name: string): string | undefined => process.env[name] || undefined;
export const appUrl = (): string => env("APP_URL").replace(/\/+$/, "");

export const DEFAULT_API_VERSION = "v26";
export const CHARACTER_LIMIT = 25_000;
