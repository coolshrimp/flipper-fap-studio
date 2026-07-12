import * as https from 'https';

interface GitHubRelease {
    tag_name: string;
    html_url: string;
}

function fetchLatestRelease(owner: string, repo: string): Promise<GitHubRelease> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${owner}/${repo}/releases/latest`,
            headers: { 'User-Agent': 'flipper-fap-studio-vscode' },
        };
        https.get(options, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data) as GitHubRelease); }
                catch { reject(new Error('Failed to parse GitHub response')); }
            });
        }).on('error', reject);
    });
}

export async function checkUfbtVersion(): Promise<{ status: string; installed: string; latest: string; url: string }> {
    const release = await fetchLatestRelease('flipperdevices', 'flipperzero-ufbt');
    return {
        status: 'Unknown (check manually)',
        installed: 'run: ufbt --version',
        latest: release.tag_name,
        url: release.html_url,
    };
}

export async function checkFirmwareRelease(owner: string, repo: string): Promise<{ latest: string; url: string }> {
    const release = await fetchLatestRelease(owner, repo);
    return { latest: release.tag_name, url: release.html_url };
}

export const FIRMWARE_REPOS = {
    oem:         { owner: 'flipperdevices', repo: 'flipperzero-firmware',    label: 'OEM Firmware' },
    rogueMaster: { owner: 'RogueMaster',    repo: 'flipperzero-firmware-wPlugins', label: 'RogueMaster' },
    momentum:    { owner: 'Next-Flip',      repo: 'Momentum-Firmware',       label: 'Momentum' },
    unleashed:   { owner: 'DarkFlippers',   repo: 'unleashed-firmware',      label: 'Unleashed' },
};
