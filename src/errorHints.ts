export interface ErrorHint {
    title: string;
    detail: string;
}

const PATTERNS: Array<{ test: RegExp; hint: ErrorHint }> = [
    {
        test: /has to be closed manually/i,
        hint: {
            title: 'App still running on Flipper',
            detail: 'An app is currently open on your Flipper Zero and must be closed before a new one can be launched.\n\nOn your Flipper: press the Back button until you return to the main menu, then try again.',
        },
    },
    {
        test: /closing current app/i,
        hint: {
            title: 'App close timed out',
            detail: 'uFBT tried to close the running app but it did not respond.\n\nOn your Flipper: press Back to exit the current app, then try Build + Launch again.',
        },
    },
    {
        test: /no serial port|no flipper|failed to find|com port.*not found|cannot find.*port/i,
        hint: {
            title: 'Flipper not detected',
            detail: 'Your Flipper Zero was not found on any USB port.\n\nTry:\n• Plug in the USB cable\n• Unlock the Flipper screen\n• Use a data cable (not a charge-only cable)\n• Try a different USB port',
        },
    },
    {
        test: /unexpected response.*walkie|unexpected response.*music|unexpected response.*nfc|unexpected response.*ir|unexpected response.*sub/i,
        hint: {
            title: 'Incompatible app running',
            detail: 'A system app on the Flipper is blocking the launch (e.g. Walkie Talkie, Music Player).\n\nClose the app on your Flipper manually using the Back button, then try again.',
        },
    },
    {
        test: /api.*mismatch|mismatch.*api|wrong api|incompatible api/i,
        hint: {
            title: 'API version mismatch',
            detail: 'The app was built against a different firmware API version than what is on your Flipper.\n\nTry:\n• Run Clean, then rebuild\n• Update the firmware SDK path in Settings\n• Make sure your Flipper firmware matches the SDK target',
        },
    },
    {
        test: /failed to start ufbt|ufbt.*not found|\'ufbt\' is not recognized|ufbt.*command not found/i,
        hint: {
            title: 'uFBT is not installed',
            detail: 'The uFBT build tool could not be found on your system.\n\nClick "Install / Update uFBT" in the sidebar, or run:\n  pip install -U ufbt\n\nMake sure Python is on your PATH.',
        },
    },
    {
        test: /error:.*undeclared|implicit declaration of function|unknown type name|use of undeclared identifier/i,
        hint: {
            title: 'Missing include or typo in C code',
            detail: 'A function or type is used that the compiler cannot find.\n\nCommon fixes:\n• Add the missing #include at the top of your .c file\n• Check for typos in function or type names\n• See the Output panel for the exact line number',
        },
    },
    {
        test: /undefined reference to/i,
        hint: {
            title: 'Linker error — symbol not found',
            detail: 'A function is called but its definition cannot be found during linking.\n\nCommon fixes:\n• Make sure all .c source files are listed in application.fam\n• Check that you are calling the correct function name\n• See the Output panel for which symbol is missing',
        },
    },
    {
        test: /stack.*overflow|stack.*size|stack_size/i,
        hint: {
            title: 'Stack size issue',
            detail: 'The app may be exceeding its allocated stack.\n\nTry increasing stack_size in your application.fam:\n  stack_size=4096,\n\nDefault is 2048 bytes.',
        },
    },
    {
        test: /no such file or directory.*\.h|cannot open.*include/i,
        hint: {
            title: 'Missing header file',
            detail: 'A required header file could not be found.\n\nCheck:\n• The header path is correct and uses forward slashes\n• The SDK target in Settings is pointing to the right firmware folder\n• The firmware SDK contains the header your code needs',
        },
    },
    {
        test: /error.*appchk|appchk.*error|manifest.*error/i,
        hint: {
            title: 'App manifest error (application.fam)',
            detail: 'There is a problem with your application.fam file.\n\nCheck:\n• appid, name, entry_point are all set\n• fap_version is in the form (1, 0)\n• apptype is FlipperAppType.EXTERNAL\n• No trailing commas on the last field',
        },
    },
];

export function getErrorHints(log: string): ErrorHint[] {
    const seen = new Set<string>();
    const hints: ErrorHint[] = [];

    for (const { test, hint } of PATTERNS) {
        if (test.test(log) && !seen.has(hint.title)) {
            seen.add(hint.title);
            hints.push(hint);
        }
    }

    return hints;
}

export function formatHintsForModal(hints: ErrorHint[]): string {
    return hints
        .map((h, i) => `${i + 1}. ${h.title}\n${h.detail}`)
        .join('\n\n─────────────────────\n\n');
}
