import diphyx from "@diphyx/eslint-plugin";

export default [
    ...diphyx.configs.recommended,
    {
        ignores: ["node_modules/**", "**/dist/**", "**/*.d.ts"],
    },
];
