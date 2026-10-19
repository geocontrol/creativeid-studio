/**
 * ATProto timestamp identifiers (TIDs).
 *
 * A TID is 13 characters of base32-sortable text encoding a 64-bit integer:
 * top bit 0, then 53 bits of microseconds since the Unix epoch, then a
 * 10-bit clock identifier. TIDs sort lexically in creation order.
 *
 * Every work and connection gets a TID when it is created locally. The same
 * value later becomes its ATProto record key, so republishing updates the
 * record in place instead of creating a duplicate.
 *
 * Spec: https://atproto.com/specs/tid
 */

const S32_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
const TID_PATTERN = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

export function isTid(value: string): boolean {
  return TID_PATTERN.test(value);
}

function encode(value: bigint): string {
  let out = "";
  for (let i = 12; i >= 0; i--) {
    out += S32_ALPHABET[Number((value >> BigInt(5 * i)) & 31n)];
  }
  return out;
}

export interface TidGenerator {
  /** Next TID; strictly greater than every TID this generator returned before. */
  next(now?: Date): string;
}

/**
 * Creates a generator with a fixed clock id (0–1023). Monotonic even if the
 * wall clock stalls or steps backwards.
 */
export function createTidGenerator(
  clockId: number = Math.floor(Math.random() * 1024)
): TidGenerator {
  if (!Number.isInteger(clockId) || clockId < 0 || clockId > 1023) {
    throw new RangeError(`TID clock id must be an integer 0–1023 (got ${clockId}).`);
  }
  const clock = BigInt(clockId);
  let lastMicros = 0n;
  return {
    next(now: Date = new Date()): string {
      let micros = BigInt(now.getTime()) * 1000n;
      if (micros <= lastMicros) micros = lastMicros + 1n;
      lastMicros = micros;
      return encode((micros << 10n) | clock);
    },
  };
}

const defaultGenerator = createTidGenerator();

/** Next TID from the process-wide generator. */
export function nextTid(now?: Date): string {
  return defaultGenerator.next(now);
}
