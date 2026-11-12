import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/unit/**/*.test.ts", "packages/*/test/**/*.test.ts"],
        coverage: {
            provider: "v8",
            /* Every package's source; its types file, types only, holds no code to run. */
            include: ["packages/*/src/**/*.ts"],
            exclude: ["packages/*/src/types.ts"],
            reporter: ["text-summary", "text"],
            reportsDirectory: ".coverage",
            /* The floor: below it, a run fails. What is left is code no test can run. */
            thresholds: { lines: 99.5, statements: 99.5, branches: 99, functions: 100 },
        },
    },
});
