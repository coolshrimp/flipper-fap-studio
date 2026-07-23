export type SimulatorOp =
    | 'clear'
    | 'setFont'
    | 'setColor'
    | 'invertColor'
    | 'text'
    | 'textAligned'
    | 'box'
    | 'frame'
    | 'rbox'
    | 'rframe'
    | 'line'
    | 'dot'
    | 'circle'
    | 'disc'
    | 'xbm'
    | 'icon'
    | 'button';

export interface SimulatorCommand {
    op: SimulatorOp;
    args: Array<number | string>;
    raw: string;
}

export interface SimulatorScreen {
    name: string;
    sourceFile: string;
    commands: SimulatorCommand[];
}

export interface SimulatorSource {
    filePath: string;
    content: string;
}

export interface SimulatorParseResult {
    screens: SimulatorScreen[];
    bitmaps: Record<string, number[]>;
    warnings: string[];
    parsedCalls: number;
}

interface CanvasFunction {
    name: string;
    body: string;
    params: string[];
    paramDeclarations: string[];
    sourceFile: string;
}

interface FoundCall {
    name: string;
    argsText: string;
    raw: string;
}

type Bindings = Record<string, string>;

interface SourceSymbols {
    constants: Record<string, number>;
    stringArrays: Record<string, string[]>;
}

interface ParseEnvironment {
    functionsBySource: Map<string, Map<string, CanvasFunction>>;
    globalFunctions: Map<string, CanvasFunction>;
    helperNames: Set<string>;
    symbolsBySource: Map<string, SourceSymbols>;
    globalSymbols: SourceSymbols;
    warnings: Set<string>;
    expansionCount: number;
    totalExpansionCount: number;
    loopExpansionCount: number;
    totalLoopExpansionCount: number;
    emittedCommandCount: number;
    totalEmittedCommandCount: number;
    bitmapBindings: Map<string, { sourceFile: string; name: string }>;
    nextBitmapBindingId: number;
}

interface ResolvedNumber {
    value: number;
    approximate: boolean;
}

const SUPPORTED_CALLS = new Set([
    'canvas_clear',
    'canvas_set_font',
    'canvas_set_color',
    'canvas_invert_color',
    'canvas_draw_str',
    'canvas_draw_str_aligned',
    'canvas_draw_box',
    'canvas_draw_frame',
    'canvas_draw_rbox',
    'canvas_draw_rframe',
    'canvas_draw_line',
    'canvas_draw_dot',
    'canvas_draw_circle',
    'canvas_draw_disc',
    'canvas_draw_xbm',
    'canvas_draw_icon',
    'elements_button_left',
    'elements_button_center',
    'elements_button_right',
]);
const MAX_CALLS_PER_BLOCK = 5_000;
const MAX_HELPER_DEPTH = 10;
const MAX_HELPER_EXPANSIONS = 1_000;
const MAX_TOTAL_HELPER_EXPANSIONS = 5_000;
const MAX_LOOP_ITERATIONS = 12;
const MAX_LOOP_EXPANSIONS_PER_SCREEN = 512;
const MAX_TOTAL_LOOP_EXPANSIONS = 4_096;
const MAX_EMITTED_COMMANDS = 8_000;
const MAX_TOTAL_EMITTED_COMMANDS = 20_000;
const MAX_SCREENS = 256;

/** Parse Flipper drawing source without compiling or executing project code. */
export function parseSimulatorSources(sources: SimulatorSource[]): SimulatorParseResult {
    const warnings = new Set<string>();
    const screens: SimulatorScreen[] = [];
    let parsedCalls = 0;

    const functions = sources.flatMap(source =>
        extractCanvasFunctions(source.content, source.filePath)
    );
    const functionsBySource = new Map<string, Map<string, CanvasFunction>>();
    const functionGroups = new Map<string, CanvasFunction[]>();
    for (const fn of functions) {
        let sourceFunctions = functionsBySource.get(fn.sourceFile);
        if (!sourceFunctions) {
            sourceFunctions = new Map<string, CanvasFunction>();
            functionsBySource.set(fn.sourceFile, sourceFunctions);
        }
        sourceFunctions.set(fn.name, fn);
        const group = functionGroups.get(fn.name) || [];
        group.push(fn);
        functionGroups.set(fn.name, group);
    }
    const globalFunctions = new Map<string, CanvasFunction>();
    for (const [name, group] of functionGroups) {
        if (group.length === 1) { globalFunctions.set(name, group[0]); }
    }

    const stringArraysBySource = new Map<string, Record<string, string[]>>();
    const stringArrayGroups = new Map<string, string[][]>();
    for (const source of sources) {
        const arrays = parseStringArrays(source.content);
        stringArraysBySource.set(source.filePath, arrays);
        for (const [name, values] of Object.entries(arrays)) {
            const group = stringArrayGroups.get(name) || [];
            group.push(values);
            stringArrayGroups.set(name, group);
        }
    }
    const globalStringArrays: Record<string, string[]> = {};
    for (const [name, group] of stringArrayGroups) {
        const distinct = new Set(group.map(values => JSON.stringify(values)));
        if (distinct.size === 1) { globalStringArrays[name] = group[0]; }
    }
    const { constantsBySource, globalConstants } = buildScopedConstants(
        sources, stringArraysBySource, globalStringArrays
    );
    const symbolsBySource = new Map<string, SourceSymbols>();
    for (const source of sources) {
        symbolsBySource.set(source.filePath, {
            constants: {
                ...globalConstants,
                ...(constantsBySource.get(source.filePath) || {}),
            },
            stringArrays: {
                ...globalStringArrays,
                ...(stringArraysBySource.get(source.filePath) || {}),
            },
        });
    }
    const helperNames = new Set(functionGroups.keys());
    const env: ParseEnvironment = {
        functionsBySource,
        globalFunctions,
        helperNames,
        symbolsBySource,
        globalSymbols: {
            constants: globalConstants,
            stringArrays: globalStringArrays,
        },
        warnings,
        expansionCount: 0,
        totalExpansionCount: 0,
        loopExpansionCount: 0,
        totalLoopExpansionCount: 0,
        emittedCommandCount: 0,
        totalEmittedCommandCount: 0,
        bitmapBindings: new Map<string, { sourceFile: string; name: string }>(),
        nextBitmapBindingId: 1,
    };

    const referencedHelpers = new Set<string>();
    for (const fn of functions) {
        for (const call of findCalls(fn.body, helperNames)) {
            const helper = resolveHelper(env, fn.sourceFile, call.name);
            if (helper && functionKey(helper) !== functionKey(fn)) {
                referencedHelpers.add(functionKey(helper));
            }
        }
    }

    const namedCallbacks = functions.filter(fn => /(?:draw|render).*callback/i.test(fn.name));
    const callbacks = namedCallbacks.length > 0
        ? namedCallbacks
        : functions.filter(fn =>
            !referencedHelpers.has(functionKey(fn)) && extractCaseBodies(fn.body).length > 0
        );
    let roots = callbacks.length > 0
        ? callbacks
        : functions.filter(fn => !referencedHelpers.has(functionKey(fn)));
    if (roots.length === 0) { roots = functions; }

    for (const root of roots) {
        if (screens.length >= MAX_SCREENS) {
            warnings.add(`Screen discovery was capped at ${MAX_SCREENS} preview screens.`);
            break;
        }
        if (env.totalEmittedCommandCount >= MAX_TOTAL_EMITTED_COMMANDS) { break; }
        const cases = extractCaseBodies(root.body);
        if (cases.length > 0) {
            for (const item of cases) {
                if (screens.length >= MAX_SCREENS) {
                    warnings.add(`Screen discovery was capped at ${MAX_SCREENS} preview screens.`);
                    break;
                }
                if (env.totalEmittedCommandCount >= MAX_TOTAL_EMITTED_COMMANDS) { break; }
                env.expansionCount = 0;
                env.loopExpansionCount = 0;
                env.emittedCommandCount = 0;
                const commands = parseExpanded(
                    item.body, env, {}, [functionKey(root)], 0, root.sourceFile
                );
                if (commands.length === 0) { continue; }
                parsedCalls += commands.length;
                screens.push({
                    name: humanizeScreenName(item.name),
                    sourceFile: root.sourceFile,
                    commands,
                });
            }
            continue;
        }

        env.expansionCount = 0;
        env.loopExpansionCount = 0;
        env.emittedCommandCount = 0;
        const commands = parseExpanded(
            root.body, env, {}, [functionKey(root)], 0, root.sourceFile
        );
        if (commands.length === 0) { continue; }
        parsedCalls += commands.length;
        screens.push({
            name: humanizeScreenName(root.name),
            sourceFile: root.sourceFile,
            commands,
        });
    }

    if (functions.length === 0) {
        for (const source of sources) {
            if (screens.length >= MAX_SCREENS) {
                warnings.add(`Screen discovery was capped at ${MAX_SCREENS} preview screens.`);
                break;
            }
            if (env.totalEmittedCommandCount >= MAX_TOTAL_EMITTED_COMMANDS) { break; }
            env.expansionCount = 0;
            env.loopExpansionCount = 0;
            env.emittedCommandCount = 0;
            const commands = parseExpanded(source.content, env, {}, [], 0, source.filePath);
            if (commands.length === 0) { continue; }
            parsedCalls += commands.length;
            screens.push({
                name: humanizeScreenName(fileStem(source.filePath)),
                sourceFile: source.filePath,
                commands,
            });
        }
    }

    if (screens.length === 0) {
        warnings.add('No supported Canvas drawing calls were found in the app source.');
    }

    const bitmapRequests = new Map<string, { sourceFile: string; name: string }>();
    for (const screen of screens) {
        for (const command of screen.commands) {
            if (command.op === 'xbm' && typeof command.args[4] === 'string') {
                const request = parseBitmapKey(command.args[4]);
                if (request) { bitmapRequests.set(command.args[4], request); }
            }
        }
    }
    const bitmaps: Record<string, number[]> = {};
    if (bitmapRequests.size > 0) {
        const requestedNames = new Set(
            [...bitmapRequests.values()].map(request => request.name)
        );
        const bitmapsBySource = new Map<string, Record<string, number[]>>();
        const bitmapGroups = new Map<string, number[][]>();
        for (const source of sources) {
            const parsed = parseBitmapArrays(source.content, requestedNames);
            bitmapsBySource.set(source.filePath, parsed);
            for (const [name, values] of Object.entries(parsed)) {
                const group = bitmapGroups.get(name) || [];
                group.push(values);
                bitmapGroups.set(name, group);
            }
        }
        const globalBitmaps: Record<string, number[]> = {};
        for (const [name, group] of bitmapGroups) {
            if (new Set(group.map(values => JSON.stringify(values))).size === 1) {
                globalBitmaps[name] = group[0];
            }
        }
        for (const [key, request] of bitmapRequests) {
            const values = bitmapsBySource.get(request.sourceFile)?.[request.name] ||
                globalBitmaps[request.name];
            if (values) {
                bitmaps[key] = values;
            } else {
                warnings.add(
                    `Bitmap data could not be resolved unambiguously for: ${request.name}`
                );
            }
        }
    }

    return {
        screens: uniqueScreenNames(screens),
        bitmaps,
        warnings: [...warnings],
        parsedCalls,
    };
}

function extractCanvasFunctions(source: string, sourceFile: string): CanvasFunction[] {
    const functions: CanvasFunction[] = [];
    const searchable = maskNonCode(source);
    const signature = /\b(?:static\s+)?void\s+([A-Za-z_]\w*)\s*\(([^)]*\bCanvas\s*\*\s*[A-Za-z_]\w*[^)]*)\)\s*\{/g;
    let match: RegExpExecArray | null;

    while ((match = signature.exec(searchable)) !== null) {
        const paramOpen = searchable.indexOf('(', match.index);
        const paramClose = findMatching(searchable, paramOpen, '(', ')');
        const open = searchable.indexOf('{', paramClose + 1);
        const close = findMatching(searchable, open, '{', '}');
        if (paramClose < 0 || open < 0 || close < 0) { continue; }
        const paramDeclarations = splitArguments(source.slice(paramOpen + 1, paramClose));
        functions.push({
            name: match[1],
            body: source.slice(open + 1, close),
            params: paramDeclarations.map(parameterName).filter(Boolean),
            paramDeclarations,
            sourceFile,
        });
        signature.lastIndex = close + 1;
    }
    return functions;
}

function extractCaseBodies(body: string): Array<{ name: string; body: string }> {
    const searchable = maskNonCode(body);
    const switchRe = /\bswitch\s*\(/g;
    let switchMatch: RegExpExecArray | null;
    let best: { score: number; cases: Array<{ name: string; body: string }> } | null = null;

    while ((switchMatch = switchRe.exec(searchable)) !== null) {
        const parenOpen = searchable.indexOf('(', switchMatch.index);
        const parenClose = findMatching(searchable, parenOpen, '(', ')');
        if (parenClose < 0) { continue; }
        const braceOpen = searchable.indexOf('{', parenClose + 1);
        if (braceOpen < 0 || /\S/.test(searchable.slice(parenClose + 1, braceOpen))) { continue; }
        const braceClose = findMatching(searchable, braceOpen, '{', '}');
        if (braceClose < 0) { continue; }

        const block = body.slice(braceOpen + 1, braceClose);
        const blockSearch = searchable.slice(braceOpen + 1, braceClose);
        const markerRe = /\b(case\s+([A-Za-z_]\w*|[-+]?(?:0[xX][0-9a-fA-F]+|\d+))\s*:|default\s*:)/g;
        const markers: Array<{ name: string; start: number; contentStart: number; isDefault: boolean }> = [];
        let marker: RegExpExecArray | null;
        let scanFrom = 0;
        let braceDepth = 0;

        while ((marker = markerRe.exec(blockSearch)) !== null) {
            for (let i = scanFrom; i < marker.index; i++) {
                if (blockSearch[i] === '{') { braceDepth++; }
                else if (blockSearch[i] === '}') { braceDepth--; }
            }
            scanFrom = marker.index + marker[0].length;
            if (braceDepth !== 0) { continue; }
            markers.push({
                name: marker[2] || 'default',
                start: marker.index,
                contentStart: marker.index + marker[0].length,
                isDefault: !marker[2],
            });
        }

        if (markers.length === 0) {
            switchRe.lastIndex = braceClose + 1;
            continue;
        }

        const prefix = topLevelOnly(body.slice(0, switchMatch.index));
        const suffix = topLevelOnly(body.slice(braceClose + 1));
        const ordered = [
            ...markers.filter(item => item.isDefault),
            ...markers.filter(item => !item.isDefault),
        ];
        const cases = ordered.map(item => {
            const index = markers.indexOf(item);
            const next = markers[index + 1];
            return {
                name: item.isDefault ? 'Main' : item.name,
                body: `${prefix}\n${block.slice(item.contentStart, next ? next.start : block.length)}\n${suffix}`,
            };
        });
        const selector = body.slice(parenOpen + 1, parenClose);
        const strongSemantic = /screen|page|scene/i;
        const weakSemantic = /view|state/i;
        let score = markers.length;
        if (strongSemantic.test(selector)) { score += 300; }
        else if (weakSemantic.test(selector)) { score += 80; }
        if (markers.some(item => strongSemantic.test(item.name))) { score += 160; }
        else if (markers.some(item => weakSemantic.test(item.name))) { score += 50; }
        const directTextCalls = block.match(
            /\b(?:canvas_draw_str(?:_aligned)?|elements_button_(?:left|center|right))\s*\(/g
        )?.length || 0;
        const directDrawCalls = block.match(/\bcanvas_draw_(?!str\b|str_aligned\b)[A-Za-z_]\w*\s*\(/g)
            ?.length || 0;
        const namedDrawHelpers = block.match(
            /\b[A-Za-z_]\w*(?:draw|render)[A-Za-z_]\w*\s*\(/gi
        )?.length || 0;
        score += Math.min(120, directTextCalls * 30);
        score += Math.min(40, directDrawCalls * 5);
        score += Math.min(30, namedDrawHelpers * 10);
        if (!best || score > best.score) { best = { score, cases }; }
        switchRe.lastIndex = braceClose + 1;
    }

    return best?.cases || [];
}

function functionKey(fn: CanvasFunction): string {
    return `${fn.sourceFile}\0${fn.name}`;
}

function resolveHelper(
    env: ParseEnvironment,
    sourceFile: string,
    name: string
): CanvasFunction | undefined {
    return env.functionsBySource.get(sourceFile)?.get(name) || env.globalFunctions.get(name);
}

function parseExpanded(
    body: string,
    env: ParseEnvironment,
    bindings: Bindings,
    stack: string[],
    depth: number,
    sourceFile: string
): SimulatorCommand[] {
    if (env.totalEmittedCommandCount >= MAX_TOTAL_EMITTED_COMMANDS) {
        env.warnings.add(
            `Total preview output was capped at ${MAX_TOTAL_EMITTED_COMMANDS} drawing commands.`
        );
        return [];
    }
    if (env.emittedCommandCount >= MAX_EMITTED_COMMANDS) {
        env.warnings.add(`Preview output was capped at ${MAX_EMITTED_COMMANDS} drawing commands.`);
        return [];
    }
    if (depth > MAX_HELPER_DEPTH) {
        env.warnings.add('Local draw-helper expansion stopped at the safety depth limit.');
        return [];
    }

    const loop = findSimpleLoop(body, env, bindings, sourceFile);
    if (loop) {
        const prefixBindings = {
            ...bindings,
            ...extractLocalBindings(loop.prefix),
        };
        const commands = parseExpanded(
            loop.prefix, env, bindings, stack, depth + 1, sourceFile
        );
        for (const value of loop.values) {
            if (env.loopExpansionCount >= MAX_LOOP_EXPANSIONS_PER_SCREEN) {
                env.warnings.add('Source loop expansion stopped at the per-screen safety limit.');
                break;
            }
            if (env.totalLoopExpansionCount >= MAX_TOTAL_LOOP_EXPANSIONS) {
                env.warnings.add('Source loop expansion stopped at the total safety limit.');
                break;
            }
            env.loopExpansionCount++;
            env.totalLoopExpansionCount++;
            commands.push(...parseExpanded(
                loop.body,
                env,
                { ...prefixBindings, [loop.variable]: String(value) },
                stack,
                depth + 1,
                sourceFile
            ));
        }
        commands.push(...parseExpanded(
            loop.suffix, env, prefixBindings, stack, depth + 1, sourceFile
        ));
        return commands;
    }

    const localBindings = { ...bindings, ...extractLocalBindings(body) };
    const commands: SimulatorCommand[] = [];
    for (const call of findCalls(body, env.helperNames)) {
        if (env.totalEmittedCommandCount >= MAX_TOTAL_EMITTED_COMMANDS) {
            env.warnings.add(
                `Total preview output was capped at ${MAX_TOTAL_EMITTED_COMMANDS} drawing commands.`
            );
            break;
        }
        if (env.emittedCommandCount >= MAX_EMITTED_COMMANDS) {
            env.warnings.add(`Preview output was capped at ${MAX_EMITTED_COMMANDS} drawing commands.`);
            break;
        }
        const helper = resolveHelper(env, sourceFile, call.name);
        if (helper) {
            const helperKey = functionKey(helper);
            if (stack.includes(helperKey)) {
                env.warnings.add(`Recursive draw helper was not expanded: ${helper.name}`);
                continue;
            }
            if (env.expansionCount >= MAX_HELPER_EXPANSIONS) {
                env.warnings.add('Local draw-helper expansion stopped at the call-count safety limit.');
                break;
            }
            if (env.totalExpansionCount >= MAX_TOTAL_HELPER_EXPANSIONS) {
                env.warnings.add('Local draw-helper expansion stopped at the total safety limit.');
                break;
            }
            env.expansionCount++;
            env.totalExpansionCount++;
            const actual = splitArguments(call.argsText);
            const childBindings: Bindings = {};
            helper.params.forEach((name, index) => {
                const substituted = substituteBindings(actual[index] || '', localBindings);
                childBindings[name] = helper.sourceFile === sourceFile
                    ? substituted
                    : freezeCallerExpression(
                        substituted,
                        helper.paramDeclarations[index] || '',
                        env,
                        sourceFile
                    );
            });
            commands.push(...parseExpanded(
                helper.body,
                env,
                childBindings,
                [...stack, helperKey],
                depth + 1,
                helper.sourceFile
            ));
            continue;
        }

        if (!SUPPORTED_CALLS.has(call.name)) {
            if (call.name.startsWith('canvas_draw_') || call.name.startsWith('elements_')) {
                env.warnings.add(`Unsupported preview call: ${call.name}`);
            }
            continue;
        }

        const command = commandFromCall(
            call,
            splitArguments(call.argsText),
            env,
            localBindings,
            sourceFile
        );
        if (command) {
            if (env.totalEmittedCommandCount >= MAX_TOTAL_EMITTED_COMMANDS) {
                env.warnings.add(
                    `Total preview output was capped at ${MAX_TOTAL_EMITTED_COMMANDS} drawing commands.`
                );
                break;
            }
            if (env.emittedCommandCount >= MAX_EMITTED_COMMANDS) {
                env.warnings.add(`Preview output was capped at ${MAX_EMITTED_COMMANDS} drawing commands.`);
                break;
            }
            commands.push(command);
            env.emittedCommandCount++;
            env.totalEmittedCommandCount++;
        }
    }
    return commands;
}

function findCalls(body: string, helperNames: Set<string> = new Set()): FoundCall[] {
    const calls: FoundCall[] = [];
    const searchable = maskNonCode(body);
    const re = /\b([A-Za-z_]\w*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(searchable)) !== null) {
        const name = match[1];
        if (!name.startsWith('canvas_') && !name.startsWith('elements_') && !helperNames.has(name)) {
            continue;
        }
        if (calls.length >= MAX_CALLS_PER_BLOCK) { break; }
        const open = searchable.indexOf('(', match.index + name.length);
        const close = findMatching(searchable, open, '(', ')');
        if (open < 0 || close < 0) { break; }
        calls.push({
            name,
            argsText: body.slice(open + 1, close),
            raw: body.slice(match.index, close + 1).replace(/\s+/g, ' ').trim(),
        });
        re.lastIndex = close + 1;
    }
    return calls;
}

function commandFromCall(
    call: FoundCall,
    args: string[],
    env: ParseEnvironment,
    bindings: Bindings,
    sourceFile: string
): SimulatorCommand | null {
    const raw = call.raw;
    const symbols = env.symbolsBySource.get(sourceFile) || env.globalSymbols;
    const nums = (indexes: number[]): number[] | null => {
        const result: number[] = [];
        for (const index of indexes) {
            const resolved = resolveIntegerExpression(
                args[index] || '', bindings, symbols.constants, symbols.stringArrays
            );
            if (!resolved) {
                env.warnings.add(`Skipped unsupported numeric expression in: ${raw}`);
                return null;
            }
            if (resolved.approximate) {
                env.warnings.add('Runtime numeric expressions use safe representative values in the preview.');
            }
            result.push(resolved.value);
        }
        return result;
    };
    const textValue = (index: number, limit: number): string => {
        let text = resolveStringExpression(
            args[index] || '',
            bindings,
            symbols.stringArrays,
            symbols.constants,
            env.warnings
        );
        if (text.length > limit) {
            env.warnings.add(`A text value was truncated to ${limit} characters for preview safety.`);
            text = text.slice(0, limit);
        }
        return text;
    };

    switch (call.name) {
        case 'canvas_clear':
            return { op: 'clear', args: [], raw };
        case 'canvas_set_font':
            return args[1] ? {
                op: 'setFont', args: [cleanIdentifier(resolveBindingExpression(args[1], bindings))], raw,
            } : null;
        case 'canvas_set_color':
            return args[1] ? {
                op: 'setColor', args: [cleanIdentifier(resolveBindingExpression(args[1], bindings))], raw,
            } : null;
        case 'canvas_invert_color':
            return { op: 'invertColor', args: [], raw };
        case 'canvas_draw_str': {
            const xy = nums([1, 2]);
            if (!xy) { return null; }
            const text = textValue(3, 512);
            if (!text) { return null; }
            return { op: 'text', args: [xy[0], safeTextBaseline(xy[1], args[2]), text], raw };
        }
        case 'canvas_draw_str_aligned': {
            const xy = nums([1, 2]);
            if (!xy) { return null; }
            const text = textValue(5, 512);
            if (!text) { return null; }
            return {
                op: 'textAligned',
                args: [
                    xy[0], safeTextBaseline(xy[1], args[2]), text,
                    cleanIdentifier(resolveBindingExpression(args[3] || 'AlignLeft', bindings)),
                    cleanIdentifier(resolveBindingExpression(args[4] || 'AlignBottom', bindings)),
                ],
                raw,
            };
        }
        case 'canvas_draw_box':
        case 'canvas_draw_frame': {
            const values = nums([1, 2, 3, 4]);
            return values
                ? { op: call.name.endsWith('_box') ? 'box' : 'frame', args: values, raw }
                : null;
        }
        case 'canvas_draw_rbox':
        case 'canvas_draw_rframe': {
            const values = nums([1, 2, 3, 4, 5]);
            return values
                ? { op: call.name.endsWith('_rbox') ? 'rbox' : 'rframe', args: values, raw }
                : null;
        }
        case 'canvas_draw_line': {
            const values = nums([1, 2, 3, 4]);
            return values ? { op: 'line', args: values, raw } : null;
        }
        case 'canvas_draw_dot': {
            const values = nums([1, 2]);
            return values ? { op: 'dot', args: values, raw } : null;
        }
        case 'canvas_draw_circle':
        case 'canvas_draw_disc': {
            const values = nums([1, 2, 3]);
            return values
                ? { op: call.name.endsWith('_disc') ? 'disc' : 'circle', args: values, raw }
                : null;
        }
        case 'canvas_draw_xbm': {
            const values = nums([1, 2, 3, 4]);
            if (!values || !args[5]) { return null; }
            const boundName = cleanIdentifier(resolveBindingExpression(args[5], bindings));
            const boundBitmap = env.bitmapBindings.get(boundName);
            const bitmapSource = boundBitmap?.sourceFile || sourceFile;
            const name = boundBitmap?.name || boundName;
            return {
                op: 'xbm',
                args: [...values, bitmapKey(bitmapSource, name)],
                raw,
            };
        }
        case 'canvas_draw_icon': {
            const values = nums([1, 2]);
            if (!values || !args[3]) { return null; }
            env.warnings.add('Firmware-owned icons are shown as labelled placeholders in the offline preview.');
            return {
                op: 'icon',
                args: [...values, cleanIdentifier(resolveBindingExpression(args[3], bindings))],
                raw,
            };
        }
        case 'elements_button_left':
        case 'elements_button_center':
        case 'elements_button_right':
            return {
                op: 'button',
                args: [call.name.replace('elements_button_', ''), textValue(1, 128)],
                raw,
            };
        default:
            return null;
    }
}

interface SimpleLoop {
    prefix: string;
    body: string;
    suffix: string;
    variable: string;
    values: number[];
}

function findSimpleLoop(
    body: string,
    env: ParseEnvironment,
    bindings: Bindings,
    sourceFile: string
): SimpleLoop | null {
    const symbols = env.symbolsBySource.get(sourceFile) || env.globalSymbols;
    const searchable = maskNonCode(body);
    const re = /\bfor\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(searchable)) !== null) {
        const parenOpen = searchable.indexOf('(', match.index);
        const parenClose = findMatching(searchable, parenOpen, '(', ')');
        if (parenClose < 0) { return null; }
        const braceOpen = searchable.indexOf('{', parenClose + 1);
        if (braceOpen < 0 || /\S/.test(searchable.slice(parenClose + 1, braceOpen))) {
            re.lastIndex = parenClose + 1;
            continue;
        }
        const braceClose = findMatching(searchable, braceOpen, '{', '}');
        if (braceClose < 0) { return null; }
        const parts = body.slice(parenOpen + 1, parenClose).split(';').map(part => part.trim());
        if (parts.length !== 3) {
            re.lastIndex = braceClose + 1;
            continue;
        }
        const init = /^(?:(?:const\s+)?(?:u?int(?:8|16|32|64)_t|size_t|int|unsigned|long)\s+)?([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(parts[0]);
        if (!init) {
            re.lastIndex = braceClose + 1;
            continue;
        }
        const variable = init[1];
        const condition = new RegExp(`^${escapeRegExp(variable)}\\s*(<=|<|>=|>)\\s*(.+)$`).exec(parts[1]);
        if (!condition) {
            re.lastIndex = braceClose + 1;
            continue;
        }
        let step = 0;
        if (new RegExp(`^(?:${escapeRegExp(variable)}\\+\\+|\\+\\+${escapeRegExp(variable)})$`).test(parts[2])) { step = 1; }
        else if (new RegExp(`^(?:${escapeRegExp(variable)}--|--${escapeRegExp(variable)})$`).test(parts[2])) { step = -1; }
        else {
            const stepMatch = new RegExp(`^${escapeRegExp(variable)}\\s*([+-])=\\s*(.+)$`).exec(parts[2]);
            if (stepMatch) {
                const resolvedStep = resolveIntegerExpression(
                    stepMatch[2], bindings, symbols.constants, symbols.stringArrays
                );
                if (resolvedStep) { step = (stepMatch[1] === '-' ? -1 : 1) * resolvedStep.value; }
            }
        }
        const start = resolveIntegerExpression(
            init[2], bindings, symbols.constants, symbols.stringArrays
        );
        const end = resolveIntegerExpression(
            condition[2], bindings, symbols.constants, symbols.stringArrays
        );
        if (!start || !end || step === 0) {
            re.lastIndex = braceClose + 1;
            continue;
        }

        const compare = (value: number) => {
            switch (condition[1]) {
                case '<': return value < end.value;
                case '<=': return value <= end.value;
                case '>': return value > end.value;
                default: return value >= end.value;
            }
        };
        const values: number[] = [];
        for (let value = start.value; compare(value) && values.length < MAX_LOOP_ITERATIONS; value += step) {
            values.push(value);
        }
        if (values.length === MAX_LOOP_ITERATIONS && compare(values[values.length - 1] + step)) {
            env.warnings.add(`A source loop was capped at ${MAX_LOOP_ITERATIONS} preview iterations.`);
        }
        return {
            prefix: body.slice(0, match.index),
            body: body.slice(braceOpen + 1, braceClose),
            suffix: body.slice(braceClose + 1),
            variable,
            values,
        };
    }
    return null;
}

function parseStringArrays(source: string): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    const searchable = maskComments(source);
    const re = /\b(?:static\s+)?(?:const\s+)?char\s*\*\s*(?:const\s+)?([A-Za-z_]\w*)\s*\[[^\]]*\]\s*=\s*\{([\s\S]*?)\}\s*;/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(searchable)) !== null) {
        const values: string[] = [];
        let useful = false;
        for (const token of splitArguments(match[2])) {
            if (!token.trim()) { continue; }
            const literal = parseCString(token);
            if (literal !== null) {
                values.push(literal);
                useful = true;
            } else if (/^(?:NULL|nullptr|0)$/.test(token.trim())) {
                values.push('');
            } else {
                values.push('');
            }
        }
        if (useful) { result[match[1]] = values.slice(0, 256); }
    }
    return result;
}

function buildScopedConstants(
    sources: SimulatorSource[],
    stringArraysBySource: Map<string, Record<string, string[]>>,
    globalStringArrays: Record<string, string[]>
): {
    constantsBySource: Map<string, Record<string, number>>;
    globalConstants: Record<string, number>;
} {
    const builtins: Record<string, number> = { true: 1, false: 0, NULL: 0 };
    let globalConstants: Record<string, number> = { ...builtins };
    let constantsBySource = new Map<string, Record<string, number>>();

    for (let pass = 0; pass < 6; pass++) {
        const nextBySource = new Map<string, Record<string, number>>();
        const groups = new Map<string, number[]>();
        for (const source of sources) {
            const arrays = {
                ...globalStringArrays,
                ...(stringArraysBySource.get(source.filePath) || {}),
            };
            const constants = parseNumericConstants([source], arrays, globalConstants);
            nextBySource.set(source.filePath, constants);
            for (const [name, value] of Object.entries(constants)) {
                if (Object.prototype.hasOwnProperty.call(builtins, name)) { continue; }
                const group = groups.get(name) || [];
                group.push(value);
                groups.set(name, group);
            }
        }

        const nextGlobal: Record<string, number> = { ...builtins };
        for (const [name, values] of groups) {
            if (new Set(values).size === 1) { nextGlobal[name] = values[0]; }
        }
        constantsBySource = nextBySource;
        if (sameNumericRecord(globalConstants, nextGlobal)) {
            globalConstants = nextGlobal;
            break;
        }
        globalConstants = nextGlobal;
    }

    return { constantsBySource, globalConstants };
}

function sameNumericRecord(
    left: Record<string, number>,
    right: Record<string, number>
): boolean {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
        leftKeys.every(key => left[key] === right[key]);
}

function parseNumericConstants(
    sources: SimulatorSource[],
    stringArrays: Record<string, string[]>,
    seed: Record<string, number> = {}
): Record<string, number> {
    const constants: Record<string, number> = {
        ...seed,
        true: 1,
        false: 0,
        NULL: 0,
    };
    const pending: Array<{ name: string; expression: string }> = [];
    for (const source of sources) {
        const text = maskComments(source.content);
        const re = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+([^\r\n]+)$/gm;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            pending.push({ name: match[1], expression: match[2].trim() });
        }
    }
    for (const item of pending) {
        if (!['true', 'false', 'NULL'].includes(item.name)) { delete constants[item.name]; }
    }
    for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        for (const item of pending) {
            if (Object.prototype.hasOwnProperty.call(constants, item.name)) { continue; }
            const resolved = resolveIntegerExpression(item.expression, {}, constants, stringArrays);
            if (resolved && !resolved.approximate) {
                constants[item.name] = resolved.value;
                changed = true;
            }
        }
        if (!changed) { break; }
    }
    return constants;
}

function extractLocalBindings(body: string): Bindings {
    const result: Bindings = {};
    const searchable = maskComments(body);
    const numeric = /\b(?:const\s+)?(?:u?int(?:8|16|32|64)_t|size_t|int|unsigned(?:\s+long)?|long)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g;
    const strings = /\b(?:const\s+)?char\s*\*\s*(?:const\s+)?([A-Za-z_]\w*)\s*=\s*([^;]+);/g;
    let match: RegExpExecArray | null;
    while ((match = numeric.exec(searchable)) !== null) { result[match[1]] = match[2].trim(); }
    while ((match = strings.exec(searchable)) !== null) { result[match[1]] = match[2].trim(); }
    return result;
}

function freezeCallerExpression(
    expression: string,
    declaration: string,
    env: ParseEnvironment,
    sourceFile: string
): string {
    const symbols = env.symbolsBySource.get(sourceFile) || env.globalSymbols;
    const isBytePointer = /\b(?:u?int8_t|unsigned\s+char)\b/.test(declaration) &&
        /(?:\*|\[)/.test(declaration);
    if (isBytePointer) {
        const existing = expression.trim();
        if (env.bitmapBindings.has(existing)) { return existing; }
        const identifier = /^\s*&?\s*([A-Za-z_]\w*)(?:\s*\[\s*0\s*\])?\s*$/
            .exec(expression)?.[1];
        if (identifier) {
            const token = `__sim_bitmap_binding_${env.nextBitmapBindingId++}`;
            env.bitmapBindings.set(token, { sourceFile, name: identifier });
            return token;
        }
    }

    const isString = /\bchar\b/.test(declaration) && /(?:\*|\[)/.test(declaration);
    if (isString) {
        return JSON.stringify(resolveStringExpression(
            expression,
            {},
            symbols.stringArrays,
            symbols.constants,
            env.warnings
        ));
    }

    const isInteger = !/(?:\*|\[)/.test(declaration) &&
        /\b(?:bool|u?int(?:8|16|32|64)_t|size_t|int|unsigned|long|short)\b/
            .test(declaration);
    if (isInteger) {
        const resolved = resolveIntegerExpression(
            expression, {}, symbols.constants, symbols.stringArrays
        );
        if (resolved) {
            if (resolved.approximate) {
                env.warnings.add(
                    'Runtime numeric expressions use safe representative values in the preview.'
                );
            }
            return String(resolved.value);
        }
    }

    const constantBindings: Bindings = {};
    for (const [name, value] of Object.entries(symbols.constants)) {
        constantBindings[name] = String(value);
    }
    return substituteBindings(expression, constantBindings);
}

function resolveBindingExpression(expression: string, bindings: Bindings): string {
    let current = expression.trim();
    const visited = new Set<string>();
    for (let depth = 0; depth < 12; depth++) {
        if (!/^[A-Za-z_]\w*$/.test(current) || visited.has(current) || bindings[current] === undefined) {
            break;
        }
        visited.add(current);
        current = bindings[current].trim();
    }
    return current;
}

function substituteBindings(expression: string, bindings: Bindings): string {
    const searchable = maskNonCode(expression);
    const matches = [...searchable.matchAll(/\b([A-Za-z_]\w*)\b/g)];
    let result = expression;
    for (let index = matches.length - 1; index >= 0; index--) {
        const match = matches[index];
        const name = match[1];
        const start = match.index || 0;
        const previous = searchable.slice(Math.max(0, start - 2), start);
        const value = bindings[name];
        if (value === undefined || value.trim() === name || previous.endsWith('->') || previous.endsWith('.')) {
            continue;
        }
        result = `${result.slice(0, start)}(${value})${result.slice(start + name.length)}`;
    }
    return resolveBindingExpression(result, bindings);
}

function resolveStringExpression(
    expression: string,
    bindings: Bindings,
    stringArrays: Record<string, string[]>,
    constants: Record<string, number>,
    warnings: Set<string>
): string {
    const resolved = resolveBindingExpression(expression, bindings);
    const literal = parseCString(resolved);
    if (literal !== null) { return literal; }
    if (/^(?:NULL|nullptr|0)$/.test(resolved.trim())) { return ''; }

    const array = /^([A-Za-z_]\w*)\s*\[([^\]]+)\]$/.exec(resolved.trim());
    if (array && stringArrays[array[1]]) {
        const index = resolveIntegerExpression(array[2], bindings, constants, stringArrays);
        const values = stringArrays[array[1]];
        const value = index ? values[index.value] : values.find(Boolean);
        if (value !== undefined) { return value; }
    }

    const literals = resolved.match(/"(?:\\.|[^"\\])*"/g) || [];
    if (literals.length > 0) {
        const first = parseCString(literals[0]);
        if (first !== null) { return first; }
    }

    const identifiers = resolved.match(/[A-Za-z_]\w*/g) || [];
    const ignored = new Set(['const', 'char', 'sizeof', 'NULL']);
    const rawName = [...identifiers].reverse().find(name => !ignored.has(name)) || 'runtime text';
    const label = rawName.replace(/_/g, ' ').slice(0, 28);
    const placeholder = `[${label}]`;
    warnings.add(`Runtime text is shown as ${placeholder} in the static preview.`);
    return placeholder;
}

function resolveIntegerExpression(
    expression: string,
    bindings: Bindings,
    constants: Record<string, number>,
    stringArrays: Record<string, string[]>,
    bindingDepth = 0
): ResolvedNumber | null {
    if (!expression || bindingDepth > 12) { return null; }
    let approximate = false;
    let clean = maskComments(expression).trim();
    clean = clean.replace(/\(\s*(?:const\s+)?(?:u?int(?:8|16|32|64)_t|size_t|int|unsigned(?:\s+long)?|long|char|bool)\s*\*?\s*\)/g, '');
    clean = clean.replace(/\bCOUNT_OF\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_all, name: string) => {
        if (stringArrays[name]) { return String(stringArrays[name].length); }
        approximate = true;
        return '0';
    });
    clean = clean.replace(/\b([A-Za-z_]\w*)(?:\s*(?:->|\.)\s*[A-Za-z_]\w*)+\b/g, () => {
        approximate = true;
        return '0';
    });
    clean = clean.replace(/\b([A-Za-z_]\w*)\s*\[[^\]]+\]/g, () => {
        approximate = true;
        return '0';
    });
    clean = clean.replace(/\b([A-Za-z_]\w*)\b/g, (all, name: string, offset: number) => {
        if (offset > 0 && /[0-9]/.test(clean[offset - 1]) && /^[xXbB][0-9a-fA-F]+$/.test(all)) {
            return all;
        }
        if (bindings[name] !== undefined) {
            const nested = resolveIntegerExpression(
                bindings[name], bindings, constants, stringArrays, bindingDepth + 1
            );
            if (nested) {
                approximate = approximate || nested.approximate;
                return String(nested.value);
            }
        }
        if (constants[name] !== undefined) { return String(constants[name]); }
        approximate = true;
        return '0';
    });
    clean = clean.replace(/\b(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)[uUlL]+\b/g, '$1');
    const parsed = parseArithmetic(clean);
    if (parsed === null || !Number.isSafeInteger(parsed) || Math.abs(parsed) > 65_535) { return null; }
    return { value: parsed, approximate };
}

function parseArithmetic(expression: string): number | null {
    const compact = expression.replace(/\s+/g, '');
    const tokens = compact.match(/0[xX][0-9a-fA-F]+|0[bB][01]+|\d+|[()+\-*/%]/g) || [];
    if (tokens.join('') !== compact) { return null; }
    let index = 0;
    const primary = (): number | null => {
        const token = tokens[index++];
        if (token === undefined) { return null; }
        if (token === '+' || token === '-') {
            const value = primary();
            return value === null ? null : token === '-' ? -value : value;
        }
        if (token === '(') {
            const value = add();
            if (tokens[index++] !== ')') { return null; }
            return value;
        }
        if (/^0x/i.test(token)) { return Number.parseInt(token.slice(2), 16); }
        if (/^0b/i.test(token)) { return Number.parseInt(token.slice(2), 2); }
        return /^\d+$/.test(token) ? Number.parseInt(token, 10) : null;
    };
    const multiply = (): number | null => {
        let left = primary();
        while (left !== null && ['*', '/', '%'].includes(tokens[index])) {
            const op = tokens[index++];
            const right = primary();
            if (right === null || ((op === '/' || op === '%') && right === 0)) { return null; }
            left = op === '*' ? left * right : op === '/' ? Math.trunc(left / right) : left % right;
            if (!Number.isSafeInteger(left)) { return null; }
        }
        return left;
    };
    const add = (): number | null => {
        let left = multiply();
        while (left !== null && (tokens[index] === '+' || tokens[index] === '-')) {
            const op = tokens[index++];
            const right = multiply();
            if (right === null) { return null; }
            left = op === '+' ? left + right : left - right;
            if (!Number.isSafeInteger(left)) { return null; }
        }
        return left;
    };
    const value = add();
    return value !== null && index === tokens.length ? value : null;
}

function safeTextBaseline(value: number, expression: string | undefined): number {
    if (value >= 7 && value <= 64) { return value; }
    const text = expression || '';
    let hash = 0;
    for (let i = 0; i < text.length; i++) { hash = ((hash * 31) + text.charCodeAt(i)) >>> 0; }
    return 12 + (hash % 5) * 10;
}

function parameterName(parameter: string): string {
    const clean = parameter.trim().replace(/\[[^\]]*\]\s*$/, '');
    return /([A-Za-z_]\w*)\s*$/.exec(clean)?.[1] || '';
}

function topLevelOnly(text: string): string {
    const searchable = maskNonCode(text);
    const chars = text.split('');
    let depth = 0;
    for (let i = 0; i < searchable.length; i++) {
        const ch = searchable[i];
        if (ch === '{') {
            depth++;
            chars[i] = ' ';
            continue;
        }
        if (ch === '}') {
            depth = Math.max(0, depth - 1);
            chars[i] = ' ';
            continue;
        }
        if (depth > 0 && chars[i] !== '\n' && chars[i] !== '\r') { chars[i] = ' '; }
    }
    return chars.join('');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BITMAP_KEY_SEPARATOR = '\u001f';

function bitmapKey(sourceFile: string, name: string): string {
    return `${sourceFile}${BITMAP_KEY_SEPARATOR}${name}`;
}

function parseBitmapKey(key: string): { sourceFile: string; name: string } | null {
    const separator = key.lastIndexOf(BITMAP_KEY_SEPARATOR);
    if (separator < 0) { return null; }
    return {
        sourceFile: key.slice(0, separator),
        name: key.slice(separator + BITMAP_KEY_SEPARATOR.length),
    };
}

function parseBitmapArrays(source: string, allowed: Set<string>): Record<string, number[]> {
    const result: Record<string, number[]> = {};
    const searchable = maskComments(source);
    const re = /\b(?:static\s+)?(?:const\s+)?uint8_t\s+([A-Za-z_]\w*)\s*\[[^\]]*\]\s*=\s*\{([\s\S]*?)\}\s*;/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(searchable)) !== null) {
        if (!allowed.has(match[1])) { continue; }
        const values: number[] = [];
        const tokens = match[2].split(',');
        let valid = true;
        for (const token of tokens) {
            const trimmed = token.trim();
            if (!trimmed) { continue; }
            const value = parseIntegerLiteral(trimmed);
            if (value === null || value < 0 || value > 255) {
                valid = false;
                break;
            }
            values.push(value);
        }
        if (valid && values.length > 0) { result[match[1]] = values; }
    }
    return result;
}

function splitArguments(text: string): string[] {
    text = maskComments(text);
    const args: string[] = [];
    let start = 0;
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (escaped) { escaped = false; }
            else if (ch === '\\') { escaped = true; }
            else if (ch === quote) { quote = null; }
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
        if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
        if (ch === ',' && depth === 0) {
            args.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    args.push(text.slice(start).trim());
    return args;
}

/**
 * Replace comments (and optionally quoted values) with same-length whitespace.
 * Keeping offsets stable lets the parser locate code in the cleaned copy and
 * slice the original source for string arguments and diagnostics.
 */
function maskLexical(text: string, strings: boolean): string {
    const chars = text.split('');
    let quote: string | null = null;
    let lineComment = false;
    let blockComment = false;
    let escaped = false;

    const blank = (index: number) => {
        if (chars[index] !== '\n' && chars[index] !== '\r') { chars[index] = ' '; }
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (lineComment) {
            if (ch === '\n' || ch === '\r') { lineComment = false; }
            else { blank(i); }
            continue;
        }
        if (blockComment) {
            blank(i);
            if (ch === '*' && next === '/') {
                blank(i + 1);
                i++;
                blockComment = false;
            }
            continue;
        }
        if (quote) {
            if (strings) { blank(i); }
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === quote) { quote = null; }
            continue;
        }
        if (ch === '/' && next === '/') {
            blank(i); blank(i + 1); i++; lineComment = true; continue;
        }
        if (ch === '/' && next === '*') {
            blank(i); blank(i + 1); i++; blockComment = true; continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            if (strings) { blank(i); }
        }
    }
    return chars.join('');
}

function maskNonCode(text: string): string {
    return maskLexical(text, true);
}

function maskComments(text: string): string {
    return maskLexical(text, false);
}

function findMatching(text: string, openIndex: number, open: string, close: string): number {
    if (openIndex < 0 || text[openIndex] !== open) { return -1; }
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    for (let i = openIndex; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (escaped) { escaped = false; }
            else if (ch === '\\') { escaped = true; }
            else if (ch === quote) { quote = null; }
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === open) { depth++; }
        else if (ch === close && --depth === 0) { return i; }
    }
    return -1;
}

function parseIntegerLiteral(value: string | undefined): number | null {
    if (!value) { return null; }
    let clean = value.trim();
    clean = clean.replace(/^\((?:u?int(?:8|16|32|64)_t|size_t|int|unsigned|long)\)\s*/, '');
    clean = clean.replace(/[uUlL]+$/, '');
    let parsed: number | null = null;
    if (/^[+-]?0x[0-9a-f]+$/i.test(clean)) { parsed = Number.parseInt(clean, 16); }
    if (/^[+-]?0b[01]+$/i.test(clean)) {
        const sign = clean.startsWith('-') ? -1 : 1;
        parsed = sign * Number.parseInt(clean.replace(/^[+-]?0b/i, ''), 2);
    }
    if (/^[+-]?\d+$/.test(clean)) { parsed = Number.parseInt(clean, 10); }
    return parsed !== null && Number.isSafeInteger(parsed) && Math.abs(parsed) <= 65_535
        ? parsed
        : null;
}

function parseCString(value: string | undefined): string | null {
    if (!value) { return null; }
    const clean = value.trim();
    if (!clean.startsWith('"') || !clean.endsWith('"')) { return null; }
    try {
        return JSON.parse(clean) as string;
    } catch {
        return clean.slice(1, -1)
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
}

function cleanIdentifier(value: string): string {
    return value.trim()
        .replace(/^\([^)]*\)\s*/, '')
        .replace(/^&/, '')
        .replace(/\s/g, '');
}

function fileStem(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const name = normalized.slice(normalized.lastIndexOf('/') + 1);
    return name.replace(/\.[^.]+$/, '');
}

function humanizeScreenName(value: string): string {
    return value
        .replace(/^[A-Za-z0-9_]*Screen/, '')
        .replace(/^draw_?/, '')
        .replace(/_callback$/, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .trim()
        .replace(/\b\w/g, ch => ch.toUpperCase()) || 'Main';
}

function uniqueScreenNames(screens: SimulatorScreen[]): SimulatorScreen[] {
    const counts = new Map<string, number>();
    return screens.map(screen => {
        const count = (counts.get(screen.name) || 0) + 1;
        counts.set(screen.name, count);
        return count === 1 ? screen : { ...screen, name: `${screen.name} ${count}` };
    });
}
