import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";

export default [{
  files: ["**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  plugins: { sonarjs },
  rules: {
    "sonarjs/cognitive-complexity": ["error", 15],
    "complexity": ["error", 15],
    "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
    "max-depth": ["error", 4],
    "max-params": ["error", 5],
  },
}];
