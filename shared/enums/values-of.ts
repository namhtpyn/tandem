/** enum law: every enum is an `as const` object, SCREAMING_SNAKE_CASE prop=value; derive types with ValuesOf */
export type ValuesOf<T extends Record<string, string>> = T[keyof T];
