export class RuntimeError extends Error {
  public readonly code: string;

  constructor(message: string, code = "RUNTIME_ERROR", cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export class RuntimeRegistrationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_REGISTRATION_ERROR", cause);
    this.name = "RuntimeRegistrationError";
  }
}

export class RuntimeResolutionError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_RESOLUTION_ERROR", cause);
    this.name = "RuntimeResolutionError";
  }
}

export class RuntimeModuleValidationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_MODULE_VALIDATION_ERROR", cause);
    this.name = "RuntimeModuleValidationError";
  }
}

export class RuntimeModuleLoadError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_MODULE_LOAD_ERROR", cause);
    this.name = "RuntimeModuleLoadError";
  }
}

export class RuntimeValidationError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_VALIDATION_ERROR", cause);
    this.name = "RuntimeValidationError";
  }
}

export class RuntimeCapabilityError extends RuntimeError {
  constructor(message: string, cause?: unknown) {
    super(message, "RUNTIME_CAPABILITY_ERROR", cause);
    this.name = "RuntimeCapabilityError";
  }
}

/** Semantic error categories — adapters set this so consumers don't parse error messages. */
export type RuntimeErrorCategory =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "permission"
  | "stream"
  | "unknown";

export class RuntimeExecutionError extends RuntimeError {
  public readonly category: RuntimeErrorCategory;

  constructor(message: string, cause?: unknown, category: RuntimeErrorCategory = "unknown") {
    super(message, "RUNTIME_EXECUTION_ERROR", cause);
    this.name = "RuntimeExecutionError";
    this.category = category;
  }
}

/** Check if an error is a RuntimeExecutionError with a specific category. */
export function isRuntimeErrorCategory(err: unknown, category: RuntimeErrorCategory): boolean {
  return err instanceof RuntimeExecutionError && err.category === category;
}
