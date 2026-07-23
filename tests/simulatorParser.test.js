const assert = require('node:assert/strict');
const { parseSimulatorSources } = require('../out/simulatorParser');

const source = `
static const uint8_t img_star[] = {0x01, 0x02, 3, 4};
static const uint8_t unused_audio_table[] = {9, 8, 7, 6};

static void draw_callback(Canvas* canvas, void* ctx) {
    switch(app->screen) {
    case ScreenHome:
        canvas_clear(canvas);
        canvas_set_font(canvas, FontPrimary);
        canvas_draw_str(canvas, 4, 12, "Hello");
        canvas_draw_frame(canvas, 1, 2, 20, 10);
        canvas_draw_xbm(canvas, 30, 4, 8, 4, img_star);
        break;
    case ScreenAbout:
        canvas_draw_rbox(canvas, 3, 4, 25, 12, 3);
        elements_button_center(canvas, "OK");
        break;
    default:
        break;
    }
}
`;

const result = parseSimulatorSources([{ filePath: 'main.c', content: source }]);
assert.equal(result.screens.length, 2);
assert.deepEqual(result.screens.map(screen => screen.name), ['Home', 'About']);
assert.equal(result.screens[0].commands[2].op, 'text');
assert.deepEqual(result.screens[0].commands[2].args, [4, 12, 'Hello']);
assert.equal(result.screens[1].commands.at(-1).op, 'button');
const starBitmapKey = result.screens[0].commands.find(command => command.op === 'xbm').args[4];
assert.deepEqual(result.bitmaps[starBitmapKey], [1, 2, 3, 4]);
assert.equal(Object.keys(result.bitmaps).length, 1);
assert.equal(result.bitmaps.unused_audio_table, undefined);
assert.equal(result.warnings.length, 0);

const unsupported = parseSimulatorSources([{
    filePath: 'odd.c',
    content: 'void draw(Canvas* canvas) { canvas_draw_str(canvas, x, 4, label); canvas_draw_glyph(canvas, 1, 2, 3); }',
}]);
assert.equal(unsupported.screens.length, 1);
assert.equal(unsupported.screens[0].commands[0].op, 'text');
assert.equal(unsupported.screens[0].commands[0].args[2], '[label]');
assert.ok(unsupported.warnings.some(warning => warning.includes('representative values')));
assert.ok(unsupported.warnings.some(warning => warning.includes('[label]')));
assert.ok(unsupported.warnings.some(warning => warning.includes('canvas_draw_glyph')));

const comments = parseSimulatorSources([{
    filePath: 'comments.c',
    content: `
// void fake(Canvas* canvas) { canvas_draw_str(canvas, 1, 2, "Fake"); }
static void real(Canvas* canvas) {
    /* canvas_draw_box(canvas, 0, 0, 128, 64); } */
    canvas_draw_str(canvas, /* x */ 3, 9, "case ScreenFake: canvas_draw_dot(");
}
// static const uint8_t fake_bitmap[] = { 1, 2, 3 };
`,
}]);
assert.equal(comments.screens.length, 1);
assert.equal(comments.screens[0].name, 'Real');
assert.equal(comments.screens[0].commands.length, 1);
assert.deepEqual(comments.screens[0].commands[0].args, [3, 9, 'case ScreenFake: canvas_draw_dot(']);
assert.equal(comments.bitmaps.fake_bitmap, undefined);

const sharedSwitch = parseSimulatorSources([{
    filePath: 'numeric.c',
    content: `
static void draw_numeric(Canvas* canvas) {
    canvas_clear(canvas);
    switch(view) {
        case 0:
            canvas_draw_str(canvas, 2, 8, "Zero");
            break;
        case 0x1:
            canvas_draw_str(canvas, 2, 8, "One");
            break;
    }
    canvas_draw_frame(canvas, 0, 0, 128, 64);
}
`,
}]);
assert.deepEqual(sharedSwitch.screens.map(screen => screen.name), ['0', '0x1']);
assert.deepEqual(sharedSwitch.screens[0].commands.map(command => command.op), ['clear', 'text', 'frame']);
assert.deepEqual(sharedSwitch.screens[1].commands.map(command => command.op), ['clear', 'text', 'frame']);

const extreme = parseSimulatorSources([{
    filePath: 'extreme.c',
    content: 'void draw(Canvas* canvas) { canvas_draw_box(canvas, 0, 0, 999999999, 64); }',
}]);
assert.equal(extreme.screens.length, 0);
assert.ok(extreme.warnings.some(warning => warning.includes('unsupported numeric expression')));

const helpers = parseSimulatorSources([{
    filePath: 'helpers.c',
    content: `
static const char *const items[] = {"One", "Two"};
static void header(Canvas* canvas, const char* title) {
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str(canvas, 3, 10, title);
}
static void row(Canvas* canvas, int y, const char* text) {
    canvas_draw_rbox(canvas, 1, y - 9, 126, 12, 2);
    canvas_draw_str(canvas, 5, y, text);
}
static void aligned(Canvas* canvas, AlignHorizontal horizontal) {
    canvas_draw_str_aligned(canvas, 64, 34, horizontal, AlignBottom, "Centered");
}
static void draw_callback(Canvas* canvas) {
    canvas_clear(canvas);
    switch(screen) {
        case ScreenOther:
            canvas_set_font(canvas, FontSecondary);
            aligned(canvas, AlignRight);
            break;
        default:
            header(canvas, "Menu");
            for(uint8_t i = 0; i < COUNT_OF(items); i++) {
                row(canvas, 20 + i * 12, items[i]);
            }
            break;
    }
}
`,
}]);
assert.deepEqual(helpers.screens.map(screen => screen.name), ['Main', 'Other']);
assert.deepEqual(
    helpers.screens[0].commands.filter(command => command.op === 'text').map(command => command.args),
    [[3, 10, 'Menu'], [5, 20, 'One'], [5, 32, 'Two']]
);
assert.deepEqual(
    helpers.screens[0].commands.filter(command => command.op === 'rbox').map(command => command.args[1]),
    [11, 23]
);
assert.deepEqual(
    helpers.screens[1].commands.find(command => command.op === 'textAligned').args,
    [64, 34, 'Centered', 'AlignRight', 'AlignBottom']
);

const recursive = parseSimulatorSources([{
    filePath: 'recursive.c',
    content: 'void recurse(Canvas* canvas) { recurse(canvas); canvas_draw_str(canvas, 1, 10, "Still safe"); }',
}]);
assert.equal(recursive.screens[0].commands.length, 1);
assert.ok(recursive.warnings.some(warning => warning.includes('Recursive draw helper')));

const multipleSwitches = parseSimulatorSources([{
    filePath: 'switches.c',
    content: `
static void draw_callback(Canvas* canvas) {
    switch(font_mode) {
        case 0: canvas_set_font(canvas, FontPrimary); break;
        case 1: canvas_set_font(canvas, FontSecondary); break;
    }
    switch(app->screen) {
        case ScreenHome: canvas_draw_str(canvas, 1, 10, "Home"); break;
        case ScreenAbout: canvas_draw_str(canvas, 1, 10, "About"); break;
    }
}
`,
}]);
assert.deepEqual(multipleSwitches.screens.map(screen => screen.name), ['Home', 'About']);
assert.deepEqual(
    multipleSwitches.screens.map(screen => screen.commands[0].args[2]),
    ['Home', 'About']
);

const rankedSwitches = parseSimulatorSources([{
    filePath: 'ranked-switches.c',
    content: `
static void theme_render_now(Canvas* canvas) { canvas_set_font(canvas, FontPrimary); }
static void draw_callback(Canvas* canvas) {
    switch(view_mode) {
        case 0: theme_render_now(canvas); break;
        case 1: theme_render_now(canvas); break;
        case 2: theme_render_now(canvas); break;
    }
    switch(app->screen) {
        case 0: canvas_draw_str(canvas, 1, 10, "Home"); break;
        case 1: canvas_draw_str(canvas, 1, 10, "About"); break;
    }
}
`,
}]);
assert.deepEqual(
    rankedSwitches.screens.map(screen => screen.commands.at(-1).args[2]),
    ['Home', 'About']
);

const duplicateHelpers = parseSimulatorSources([
    {
        filePath: 'alpha.c',
        content: `
static void badge(Canvas* canvas) { canvas_draw_str(canvas, 1, 10, "Alpha"); }
static void alpha_draw_callback(Canvas* canvas) { badge(canvas); }
`,
    },
    {
        filePath: 'beta.c',
        content: `
static void badge(Canvas* canvas) { canvas_draw_str(canvas, 1, 10, "Beta"); }
static void beta_draw_callback(Canvas* canvas) { badge(canvas); }
`,
    },
]);
assert.deepEqual(
    duplicateHelpers.screens.map(screen => screen.commands[0].args[2]),
    ['Alpha', 'Beta']
);

const scopedSymbols = parseSimulatorSources([
    {
        filePath: 'symbols-alpha.c',
        content: `
#define ROW_Y 11
static const char *const labels[] = {"Alpha"};
static void alpha_draw_callback(Canvas* canvas) {
    canvas_draw_str(canvas, 1, ROW_Y, labels[0]);
}
`,
    },
    {
        filePath: 'symbols-beta.c',
        content: `
#define ROW_Y 22
static const char *const labels[] = {"Beta"};
static void beta_draw_callback(Canvas* canvas) {
    canvas_draw_str(canvas, 1, ROW_Y, labels[0]);
}
`,
    },
]);
assert.deepEqual(
    scopedSymbols.screens.map(screen => screen.commands[0].args),
    [[1, 11, 'Alpha'], [1, 22, 'Beta']]
);

const crossFileArguments = parseSimulatorSources([
    {
        filePath: 'shared-helper.c',
        content: `
#define ROW_Y 11
static const char *const labels[] = {"Alpha"};
void shared_row(Canvas* canvas, int y, const char* text) {
    canvas_draw_str(canvas, 1, y, text);
}
`,
    },
    {
        filePath: 'shared-caller.c',
        content: `
#define ROW_Y 22
static const char *const labels[] = {"Beta"};
static void beta_draw_callback(Canvas* canvas) {
    shared_row(canvas, ROW_Y, labels[0]);
}
`,
    },
]);
assert.deepEqual(crossFileArguments.screens[0].commands[0].args, [1, 22, 'Beta']);

const scopedBitmaps = parseSimulatorSources([
    {
        filePath: 'bitmap-alpha.c',
        content: `
static const uint8_t icon_data[] = {1, 2};
static void alpha_draw_callback(Canvas* canvas) {
    canvas_draw_xbm(canvas, 0, 0, 2, 1, icon_data);
}
`,
    },
    {
        filePath: 'bitmap-beta.c',
        content: `
static const uint8_t icon_data[] = {3, 4};
static void beta_draw_callback(Canvas* canvas) {
    canvas_draw_xbm(canvas, 0, 0, 2, 1, icon_data);
}
`,
    },
]);
const scopedBitmapKeys = scopedBitmaps.screens.map(screen => screen.commands[0].args[4]);
assert.notEqual(scopedBitmapKeys[0], scopedBitmapKeys[1]);
assert.deepEqual(scopedBitmaps.bitmaps[scopedBitmapKeys[0]], [1, 2]);
assert.deepEqual(scopedBitmaps.bitmaps[scopedBitmapKeys[1]], [3, 4]);

const crossFileBitmap = parseSimulatorSources([
    {
        filePath: 'bitmap-helper.c',
        content: `
void shared_icon(Canvas* canvas, const uint8_t* bits) {
    canvas_draw_xbm(canvas, 0, 0, 2, 1, bits);
}
`,
    },
    {
        filePath: 'bitmap-caller.c',
        content: `
static const uint8_t icon_data[] = {5, 6};
static void bitmap_draw_callback(Canvas* canvas) {
    shared_icon(canvas, icon_data);
}
`,
    },
]);
const crossFileBitmapKey = crossFileBitmap.screens[0].commands[0].args[4];
assert.deepEqual(crossFileBitmap.bitmaps[crossFileBitmapKey], [5, 6]);
assert.ok(crossFileBitmapKey.includes('bitmap-caller.c'));

const nestedLoops = parseSimulatorSources([{
    filePath: 'nested-loops.c',
    content: `
static void draw(Canvas* canvas) {
    for(int a = 0; a < 12; a++) {
        for(int b = 0; b < 12; b++) {
            for(int c = 0; c < 12; c++) {
                for(int d = 0; d < 12; d++) {
                    for(int e = 0; e < 12; e++) {
                        canvas_draw_dot(canvas, a + b, c + d + e);
                    }
                }
            }
        }
    }
}
`,
}]);
assert.ok(nestedLoops.screens[0].commands.length <= 512);
assert.ok(nestedLoops.warnings.some(warning => warning.includes('per-screen safety limit')));

const manyHelperCalls = Array.from({ length: 500 }, () => 'stamp(canvas);').join('\n');
const manyDrawCalls = Array.from(
    { length: 20 },
    (_, index) => `canvas_draw_dot(canvas, ${index}, ${index});`
).join('\n');
const outputBudget = parseSimulatorSources([{
    filePath: 'output-budget.c',
    content: `
static void stamp(Canvas* canvas) {
    ${manyDrawCalls}
}
static void draw(Canvas* canvas) {
    ${manyHelperCalls}
}
`,
}]);
assert.equal(outputBudget.screens[0].commands.length, 8000);
assert.ok(outputBudget.warnings.some(warning => warning.includes('capped at 8000')));

const manyCases = Array.from(
    { length: 20 },
    (_, index) => `case Screen${index}: canvas_draw_dot(canvas, ${index}, 1); break;`
).join('\n');
const totalOutputBudget = parseSimulatorSources([{
    filePath: 'total-output-budget.c',
    content: `
static void stamp(Canvas* canvas) {
    ${manyDrawCalls}
}
static void draw_callback(Canvas* canvas) {
    ${manyHelperCalls}
    switch(screen) {
        ${manyCases}
    }
}
`,
}]);
assert.equal(
    totalOutputBudget.screens.reduce((sum, screen) => sum + screen.commands.length, 0),
    20000
);
assert.ok(totalOutputBudget.warnings.some(warning => warning.includes('capped at 20000')));

console.log('simulator parser tests passed');
