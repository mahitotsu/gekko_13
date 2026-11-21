// typescript-eslint の推奨の規則と、React の hooks の 2 つの規則だけを使い、整形は扱わない（gekko_11 と同じ）。
// Keycloak の画面のスクリプト（services/keycloak/theme）は、製品のものを写して直したので、対象にしない。
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "local/run/**", "services/keycloak/theme/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }] } },
  {
    // 試験は、型のない JSON の応答を読んで確かめる。応答ごとに型を書くと、何を確かめるかが読みにくくなる
    files: ["services/*/test/**/*.ts", "packages/*/test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: ["services/customer-app/web/**/*.tsx", "services/customer-app/web/**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" },
  },
);
