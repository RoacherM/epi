import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";

export default [{
  files: ["**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  plugins: { sonarjs },
  rules: {
    "sonarjs/cognitive-complexity": ["warn", 15],
    "complexity": ["warn", 15],
    "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
    "max-depth": ["warn", 4],
    "max-params": ["warn", 5],
  },
}];
