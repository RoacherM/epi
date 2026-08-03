import { MmpArgumentError } from "./errors.js";
const RESERVED_RESOURCE_FLAGS = {
    "--extension": true,
    "-e": true,
    "--no-extensions": true,
    "-ne": true,
    "--skill": true,
    "--no-skills": true,
    "-ns": true,
    "--prompt-template": true,
    "--no-prompt-templates": true,
    "-np": true,
    "--theme": true,
    "--no-themes": true,
    "--no-context-files": true,
    "-nc": true,
    "--system-prompt": true,
    "--append-system-prompt": true,
};
const RESERVED_RESOURCE_VALUE_FLAGS = [
    "--extension",
    "--skill",
    "--prompt-template",
    "--theme",
    "--system-prompt",
    "--append-system-prompt",
];
function findReservedResourceFlag(argument) {
    if (RESERVED_RESOURCE_FLAGS[argument] === true) {
        return argument;
    }
    return RESERVED_RESOURCE_VALUE_FLAGS.find((flag) => argument.startsWith(`${flag}=`));
}
export function parseMmpArgs(argv) {
    const passthrough = [];
    let dryRun = false;
    let noProject = false;
    let version = false;
    let projectTrustOverride;
    let optionsEnded = false;
    for (const argument of argv) {
        if (optionsEnded) {
            passthrough.push(argument);
            continue;
        }
        if (argument === "--") {
            optionsEnded = true;
            passthrough.push(argument);
            continue;
        }
        const reservedFlag = findReservedResourceFlag(argument);
        if (reservedFlag !== undefined) {
            throw new MmpArgumentError(`${reservedFlag} is managed by the MMP manifest and cannot be passed directly`);
        }
        switch (argument) {
            case "--dry-run":
                dryRun = true;
                break;
            case "--no-project":
                noProject = true;
                break;
            case "--approve":
            case "-a":
                if (projectTrustOverride === false) {
                    throw new MmpArgumentError("--approve and --no-approve cannot be used together");
                }
                projectTrustOverride = true;
                passthrough.push(argument);
                break;
            case "--no-approve":
            case "-na":
                if (projectTrustOverride === true) {
                    throw new MmpArgumentError("--approve and --no-approve cannot be used together");
                }
                projectTrustOverride = false;
                passthrough.push(argument);
                break;
            case "--version":
            case "-v":
                version = true;
                break;
            default:
                passthrough.push(argument);
        }
    }
    return {
        dryRun,
        noProject,
        version,
        projectTrustOverride,
        passthrough,
    };
}
//# sourceMappingURL=args.js.map