# /aif-best-practices — Code Quality Guidelines

Reference guide for best practices for writing clean, maintainable code. Used by other skills as a reference, but can be called directly for recommendations.

## Usage

```
/aif-best-practices              # general overview
/aif-best-practices naming       # naming rules
/aif-best-practices error-handling
/aif-best-practices testing
```

## Topics

**Naming**

- Files: kebab-case
- Classes: PascalCase
- Functions/variables: camelCase
- Constants: SCREAMING_SNAKE_CASE
- Booleans: `is/has/can` prefix

**Code structure**

- Single responsibility per module/function
- Functions up to 30 lines
- No more than 3 levels of nesting

**Error Handling**

- Always log with context
- Never swallow errors in an empty catch
- Fail fast at system boundaries

**Testing**

- Minimum 70% coverage
- Name tests: `should <expected> when <condition>`
- Arrange / Act / Assert structure

**Logging**

- Structured logs (JSON)
- Context object as the first argument
- Levels: debug / info / warn / error
