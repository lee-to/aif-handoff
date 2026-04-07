import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "data/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "prefer-const": "off",
    },
  },
  {
    files: [
      "packages/api/src/**/*.{ts,tsx}",
      "packages/agent/src/**/*.{ts,tsx}",
      "packages/mcp/src/**/*.{ts,tsx}",
      "packages/runtime/src/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@aif/shared",
              importNames: ["getDb", "createTestDb", "closeDb"],
              message: "Use centralized data access via @aif/data.",
            },
            {
              name: "@aif/shared/server",
              message: "Use centralized data access via @aif/data.",
            },
            {
              name: "drizzle-orm",
              message: "SQL query construction is restricted to @aif/data.",
            },
            {
              name: "better-sqlite3",
              message: "Use centralized data access via @aif/data.",
            },
            {
              name: "drizzle-orm/better-sqlite3",
              message: "Use centralized data access via @aif/data.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/runtime/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@aif/shared",
              importNames: ["getDb", "createTestDb", "closeDb"],
              message: "Runtime must not access DB directly. Use @aif/data if needed.",
            },
            {
              name: "@aif/data",
              message: "Runtime layer must not depend on data-access layer.",
            },
            {
              name: "@aif/api",
              message: "Runtime layer must not depend on application packages.",
            },
            {
              name: "@aif/agent",
              message: "Runtime layer must not depend on agent package.",
            },
            {
              name: "@aif/web",
              message: "Runtime layer must not depend on web package.",
            },
            {
              name: "@aif/mcp",
              message: "Runtime layer must not depend on MCP package.",
            },
            {
              name: "drizzle-orm",
              message: "Runtime must not use SQL/ORM directly.",
            },
            {
              name: "better-sqlite3",
              message: "Runtime must not access SQLite directly.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/shared/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@aif/runtime",
              message: "Shared layer must not depend on runtime layer.",
            },
            {
              name: "@aif/data",
              message: "Shared layer must not depend on data-access layer.",
            },
            {
              name: "@aif/api",
              message: "Shared layer must not depend on application packages.",
            },
            {
              name: "@aif/agent",
              message: "Shared layer must not depend on application packages.",
            },
            {
              name: "@aif/web",
              message: "Shared layer must not depend on application packages.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/web/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@aif/shared",
              message: "Web must import shared contracts from @aif/shared/browser.",
            },
            {
              name: "@aif/shared/server",
              message: "Web must not import server-side DB helpers.",
            },
            {
              name: "@aif/data",
              message: "Web must not import data-access layer modules.",
            },
            {
              name: "@aif/runtime",
              message:
                "Web must not import runtime directly. Use @aif/shared/browser for shared types.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/**/__tests__/**/*.{ts,tsx}", "packages/**/*.{test,spec}.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-imports": "off",
    },
  },
);
