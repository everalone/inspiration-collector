const PART = '(0|[1-9]\\d*)';
const RELEASE_VERSION = new RegExp(`^${PART}\\.${PART}\\.${PART}(?:\\.${PART})?$`);
const PACKAGE_VERSION = new RegExp(`^${PART}\\.${PART}\\.${PART}(?:\\+${PART})?$`);

/** External release versions are stable three/four-part numbers, never SemVer prereleases or metadata. */
export function parseReleaseVersion(value, { allowPrefix = false } = {}) {
  if (typeof value !== 'string') return null;
  const version = allowPrefix && value.startsWith('v') ? value.slice(1) : value;
  const match = RELEASE_VERSION.exec(version);
  if (!match) return null;
  const numbers = match.slice(1).filter(part => part !== undefined).map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : null;
}

/** npm uses 0.2.4+1; users, release tags and artifact names use 0.2.4.1. */
export function toReleaseVersion(packageVersion) {
  const match = typeof packageVersion === 'string' ? PACKAGE_VERSION.exec(packageVersion) : null;
  const parts = match?.slice(1).filter(part => part !== undefined);
  if (!parts || !parts.every(part => Number.isSafeInteger(Number(part)))) {
    throw new Error('Version must be stable major.minor.patch with an optional numeric +revision');
  }
  return parts.join('.');
}
