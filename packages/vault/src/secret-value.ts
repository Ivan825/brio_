import { inspect } from "node:util";
import { REDACTED } from "./redactor";

/**
 * A decrypted secret that refuses to print itself. String coercion, JSON and util.inspect all give "[redacted]";
 * call reveal() at the one place the real value is needed (an adapter's request header).
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `SecretValue(${REDACTED})`;
  }
}
