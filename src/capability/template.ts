// Placeholders used inside capability values and locators:
//   {{inputs.memberId}}      -> supplied by the caller for each run
//   {{secrets.tellerPassword}} -> read from the environment at the moment of typing; never stored or logged

export interface TemplateValues {
  inputs: Record<string, string>;
  secrets?: Record<string, string>;
}

const PLACEHOLDER = /\{\{(inputs|secrets)\.([a-zA-Z0-9_]+)\}\}/g;

export function fillTemplate(text: string, values: TemplateValues): string {
  return text.replace(PLACEHOLDER, (_match, kind: string, name: string) => {
    const source = kind === "inputs" ? values.inputs : values.secrets;
    const value = source?.[name];
    if (value === undefined) throw new Error(`Missing value for {{${kind}.${name}}}`);
    return value;
  });
}

/** Fill only {{inputs.x}}; leave {{secrets.x}} for the last moment (Session.act). */
export function fillInputsOnly(text: string, inputs: Record<string, string>): string {
  return text.replace(/\{\{inputs\.([a-zA-Z0-9_]+)\}\}/g, (_match, name: string) => {
    const value = inputs[name];
    if (value === undefined) throw new Error(`Missing value for {{inputs.${name}}}`);
    return value;
  });
}

/** Fill placeholders in every string inside an object (used for locators). */
export function fillTemplateDeep<T>(value: T, values: TemplateValues): T {
  if (typeof value === "string") return fillTemplate(value, values) as T;
  if (Array.isArray(value)) return value.map((v) => fillTemplateDeep(v, values)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplateDeep(v, values)])) as T;
  }
  return value;
}

export function usesSecret(text: string): boolean {
  return /\{\{secrets\./.test(text);
}
