const assert = require('node:assert/strict');
const { parseSimulatorSources } = require('../out/simulatorParser');

const source = `
static const uint8_t decoder_lookup[] = {1, 2, 3, 4};
static const char *const main_items[] = {
    "Now Playing", "Song List", "Settings", "About",
};

static void draw_header(Canvas* canvas, const char* title) {
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str(canvas, 3, 10, title);
}
static void draw_row(Canvas* canvas, uint8_t y, const char* text) {
    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str(canvas, 5, y, text);
}
static void draw_main(Canvas* canvas) {
    draw_header(canvas, "MP3 Player");
    for(uint8_t i = 0; i < COUNT_OF(main_items); i++) {
        draw_row(canvas, 25 + i * 12, main_items[i]);
    }
}
static void draw_songs(Canvas* canvas) {
    draw_header(canvas, "Songs  0");
    canvas_draw_str_aligned(canvas, 64, 34, AlignCenter, AlignBottom, "No MP3 files found");
}
static void draw_settings(Canvas* canvas) {
    draw_header(canvas, "Settings");
    draw_row(canvas, 25, "Volume       50%");
}
static void draw_folder(Canvas* canvas) {
    draw_header(canvas, "Dir: music");
    draw_row(canvas, 25, "[Use this folder]");
}
static void draw_about(Canvas* canvas) {
    draw_header(canvas, "About");
    draw_row(canvas, 25, "Created by Coolshrimp");
}
static void draw_now_playing(Canvas* canvas) {
    char title[128];
    canvas_draw_str(canvas, 5, 10, "MP3");
    canvas_draw_str_aligned(canvas, 64, 24, AlignCenter, AlignBottom, title);
}
static void mp3_draw_callback(Canvas* canvas) {
    canvas_clear(canvas);
    switch(screen) {
        case Mp3ScreenSongs: draw_songs(canvas); break;
        case Mp3ScreenSettings: draw_settings(canvas); break;
        case Mp3ScreenFolderBrowser: draw_folder(canvas); break;
        case Mp3ScreenAbout: draw_about(canvas); break;
        case Mp3ScreenNowPlaying: draw_now_playing(canvas); break;
        default: draw_main(canvas); break;
    }
}
`;

const result = parseSimulatorSources([{ filePath: 'main.c', content: source }]);
assert.deepEqual(
    result.screens.map(screen => screen.name),
    ['Main', 'Songs', 'Settings', 'Folder Browser', 'About', 'Now Playing']
);
assert.deepEqual(
    result.screens[0].commands
        .filter(command => command.op === 'text')
        .map(command => command.args[2]),
    ['MP3 Player', 'Now Playing', 'Song List', 'Settings', 'About']
);
assert.ok(result.screens.every(screen =>
    screen.commands.some(command => command.op === 'text' || command.op === 'textAligned')
));
assert.ok(result.screens[1].commands.some(command => command.op === 'textAligned'));
assert.ok(result.screens[5].commands.some(command => command.args[2] === '[title]'));
assert.equal(Object.keys(result.bitmaps).length, 0);

console.log('simulator MP3 regression tests passed');
