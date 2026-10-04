/**
 * ScriptForge AI — Cloudflare Worker (Hugging Face Router)
 * Security‑hardened: auth, rate‑limit, CORS, input validation, sanitized errors.
 *
 * BEFORE DEPLOY:
 *   1. wrangler secret put HF_TOKEN
 *   2. wrangler secret put REQUIRED_SECRET
 *   3. wrangler kv namespace create RATE_LIMITS
 *   4. Set ALLOWED_ORIGIN in wrangler.toml (or leave empty for * pathology)
 */

const HF_ROUTER = 'https://router.huggingface.co/v1/chat/completions';
const MAX_MSG_LEN = 4000;          // per‑message content cap
const MAX_TURNS = 20;              // max messages per request
const RATE_LIMIT_PER_MIN = 60;     // per‑IP requests per minute

// ---- Configurable CORS origin (empty = *). Change to your domain for strict CORS. ----
const ALLOWED_ORIGIN = ''; // e.g. "https://your-site.com"

// ---- KV binding for rate limiting (created via `wrangler kv namespace create RATE_LIMITS`) ----
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    // If ALLOWED_ORIGIN is set, allow only that origin; otherwise allow * with Vary.
    const isLocal = ALLOWED_ORIGIN && origin.startsWith(ALLOWED_ORIGIN);
    const cors = {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
      'Content-Type': 'application/json',
    };

    if (ALLOWED_ORIGIN && !isLocal) {
      cors['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
    } else {
      // No strict origin set – allow * but mark vary so clients don’t cache incorrectly
      cors['Access-Control-Allow-Origin'] = '*';
    }

    // ---- OPTIONS preflight ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: cors });
    }

    // ---- Only POST allowed ----
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ---- API‑key authentication ----
    const apiKey = request.headers.get('x-api-key') || '';
    const requiredSecret = env.REQUIRED_SECRET || '';
    if (!requiredSecret || apiKey !== requiredSecret) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ---- Rate limit (per‑IP) ----
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateKey = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
    const current = await env.RATE_LIMITS.get(rateKey);
    if (current && Number(current) >= RATE_LIMIT_PER_MIN) {
      return new Response(JSON.stringify({ error: 'Rate limited' }), {
        status: 429,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    await env.RATE_LIMITS.put(rateKey, String(Number(current) + 1), { expirationTtl: 120 });

    // ---- Parse and validate JSON body ----
    let body;
    try {
      const raw = await request.text();
      if (raw.length > 2 * 1024 * 1024) { // 2 MB guard
        return new Response(JSON.stringify({ error: 'Payload too large' }), {
          status: 413,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      body = JSON.parse(raw);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (!body.messages || !Array.isArray(body.messages)) {
      return new Response(JSON.stringify({ error: 'Missing messages array' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (body.messages.length > MAX_TURNS) {
      return new Response(JSON.stringify({ error: 'Too many messages' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ---- Cap each message content length ----
    for (const m of body.messages) {
      if (typeof m.content !== 'string' || m.content.length > MAX_MSG_LEN) {
        return new Response(JSON.stringify({ error: 'Message content too long' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ---- Build the prompt for the HF router ----
    const userMessage = body.messages[body.messages.length - 1]?.content || '';

    const systemPrompt = `You are ScriptForge AI, an expert Windows automation specialist. Create ACCURATE, WORKING scripts that users can run immediately.

CRITICAL REQUIREMENTS:
1. READ the request carefully - if they ask for INSTALL, create INSTALL commands, not uninstall
2. Use REAL package names from winget/chocolatey, not fake ones
3. Create interactive menus when multiple options are requested
4. Test your logic - does the script actually do what the user asked?

FOR SOFTWARE INSTALLATION BATCH FILES:
- Use winget as primary method (built into Windows 10/11)
- Real winget package IDs: 7zip.7zip, Git.Git, Microsoft.SQLServerManagementStudio
- Create menu system for individual vs batch installation
- Include error handling and progress messages

WINGET PACKAGE EXAMPLES:
7-Zip: winget install --id 7zip.7zip -e --silent
Git: winget install --id Git.Git -e --silent
Notepad++: winget install --id Notepad++.Notepad++ -e --silent
SSMS: winget install --id Microsoft.SQLServerManagementStudio -e --silent

ALWAYS format response with sections:

**SOLUTION SUMMARY**
What the script does exactly.

**BUILD EXECUTABLE**
How to run/package the script.

**SECURITY CONSIDERATIONS**
Admin rights, download sources, etc.

**ROLLBACK PLAN**
How to uninstall if needed.

Then provide complete working script with proper error handling.

EXAMPLE STRUCTURE for multi-software installer:
\`\`\`batch
@echo off
setlocal EnableDelayedExpansion
title Software Installation Tool
echo.

:menu
cls
echo ============================================
echo       SOFTWARE INSTALLATION MENU
echo ============================================
echo.
echo Select an option:
echo [1] Install 7-Zip
echo [2] Install Git
echo [3] Install All Software
echo [0] Exit
echo.
set /p choice="Enter your choice (0-3): "

if "!choice!"=="1" call :install_7zip
if "!choice!"=="2" call :install_git
if "!choice!"=="3" call :install_all
if "!choice!"=="0" goto :eof
goto menu

:install_7zip
echo Installing 7-Zip...
winget install --id 7zip.7zip -e --silent --accept-package-agreements
if !errorlevel! equ 0 (echo SUCCESS: 7-Zip installed) else (echo ERROR: Failed to install 7-Zip)
pause
goto menu
\`\`\`

Generate WORKING scripts that actually install the requested software using correct package names.

--- SAFETY FILTER ---
Do NOT include any of the following in your generated script (these patterns will be rejected):
- Format-Volume, Format-, diskpart with clean or active
- Remove-Item -Recurse -Force, del /f /s /q, erase /q
- Start-Process -WindowStyle Hidden, Start-Job, Invoke-Command -ScriptBlock
- IEX, Invoke-Expression, % with unknown commands
- net user /add, net localgroup administrators /add, net user * /active:yes
- Set-ExecutionPolicy Bypass -Scope Process, Set-ExecutionPolicy Undefined
- ConvertTo-SecureString -AsPlainText -Force, Read-Host -AsSecureString (when used for passwords)
- Write-Variable -Scope Global, New-Object System.Net.WebClient
- shutdown /s /t, restart-computer, Restart-Computer -Force
- bcdedit, diskpart with select disk or clean
- Invoke-WebRequest to https:// URLs that are not winget/package sources
- Write-Host with base64-encoded payloads, ConvertFrom-SecureString to plaintext
- Any cmdlet that writes to HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run or other auto-run keys
- Start-Job, BeginInvoke, EndInvoke
- Push-Location, Pop-Location used suspiciously
- Where-Object filtering on $_.Password or similar secrets
- Select-String on credential files
- ConvertTo-PasswordString, ConvertFrom-PasswordString stored unencrypted
- Remove-Item -Path $env:windir\... or system folder deletions
- Get-ChildItem -Recurse combined with Remove-Item on system directories
- Set-ACL, Set-NTFSInheritance, icacls with /grant or /reset
- Mount-PSDrive, New-PSDrive to non-standard locations
- Import-Clixml of encrypted passwords without explicit decryption consent
- Any use of ConvertTo-SecureString followed by ConvertFrom-SecureString stored to disk
- Test-Path on paths containing %SystemRoot% or %AppData% combined with delete
- Remove-Item -Recurse -Force on $env:SystemRoot, $env:ProgramFiles, $env:ProgramFiles(x86)
- schtasks /create /sc onlogon or similar auto-start tasks
- Add-Computer -Domain or similar AD joining without explicit consent
- Publish-Settings or Set-Settings that modify global user profiles
- Invoke-Command -FilePath with paths not verified as legitimate installer files
- New-Item -ItemType SymbolicLink or mklink to system locations
- Get-Content of *.ps1 files and immediate Invoke-Expression on the result
- Register-Object or Register-WmiClass with non-standard providers
- Any command that pipes to Out-String, Out-Host with large data exfiltration risk
- Write-Output or Write-Host that includes $env: windir, $env: appdata, $env: userprofile in the output string directly
- Split-Path used with -Leaf on system paths then piped to delete commands
- ForEach-Object with -Process that modifies global state without guard clauses
- BeginBlock, ProcessBlock, EndBlock in Invoke-Command where the process block contains the dangerous patterns above
- Use of -ErrorAction SilentlyContinue or -WarningAction SilentlyContinue masking errors on dangerous commands
- Resolve-Path on untrusted input
- Select-String -Pattern with [regex] on credential material
- ConvertTo-SecureString -Key without explicit user confirmation of the key usage
- Any usage of Import-PfxCertificate without a visible confirmation prompt
- Set-Location to a path containing %temp% combined with Remove-Item
- Get-ChildItem -Recurse with -ErrorAction SilentlyContinue on system directories
- Test-Path with [-path] patterns that include $env:comspec or $env:windir and then pipe to Remove-Item
- ForEach-Object -Parallel (if using PS 7) with body containing any of the above
- Add-Member with NoteProperty containing password or secret material
- Get-Credential without immediate BeginInvoke guard or without storing to variable for explicit use only
- Set-Variable -Scope Global with material that later appears in Invoke-Command or Invoke-Expression
- New-Object PSCredential with password derived from Read-Host without -AsSecureString or without explicit Get-SecureString call followed by secure storage
- Set-Item with path patterns containing $env: windir or $env: appdata and value that is a download location
- Write-Verbose that includes $env: windir or secret variable names
- Write-Debug similarly

All generated scripts must avoid the above patterns, or the Worker will reject the output and return a 403 with a short explanation of the blocked pattern.

If your request is legitimate and you need one of these patterns, split the task: generate the script without the sensitive part, then manually append the approved portion after review.
`;

// ---- Safety validation: scan AI output for dangerous patterns ----
    const DANGEROUS_PATTERNS = [
      // Volume / disk destruction
      /format\s*-volume/i,
      /format\s*-partition/i,
      /diskpart\s+clean/i,
      /diskpart\s+active/i,

      // Recursive deletion
      /remove-item\s+-recurse\s+-force/i,
      /del\s+\/f\s+\/s\s+\/q/i,
      /erase\s+\/q/i,

      // Hidden / background execution
      /start-process\s+-windowstyle\s+hidden/i,
      /start-job/i,
      /invoke-command\s+-scriptblock/i,

      // Dangerous command injection
      /\biex\s*\(/i,
      /invoke-expression/i,
      /new-object\s+system\.net\.webclient/i,
      /set-executionpolicy\s+bypass\s+-scope\s+process/i,

      // Admin / user manipulation
      /net\s+user\s+\/add/i,
      /net\s+localgroup\s+administrators/i,

      // Secure credential leakage
      /convertto-securestring\s+-asplaintext\s+-force/i,
      /read-host\s+-assecretstring/i,

      // Global variable / secret leakage
      /write-variable\s+-scope\s+global/i,
      /import-clixml\s.*?password/i,

      // System restart / shutdown
      /shutdown\s+\/s\s+\/t/i,
      /restart-computer\s+-force/i,

      // Boot configuration / partition management
      /bcdedit/i,
      /diskpart\s+select\s+disk/i,

      // Remote code download / execute
      /invoke-webrequest\s.*?https?:\/\/[^s]*(?!winget|chocolatey|apt|brew)/i,

      // Auto-run / persistence
      /hklm:\\software\\microsoft\\windows\\currentversion\\run/i,
      /schtasks\s+\/create\s+\/sc\s+onlogon/i,

      // System path deletion
      /\$env:systemroot/i,
      /\$env:programfiles/i,
      /\$env:windir/i,

      // Suspicious permission change
      /icacls\s+\/grant/i,
      /set-acl/i,
      /set-ntfsinheritance/i,

      // Credential dump / exfil
      /lsass/i,
      /sekurlsa/i,

      // PowerShell-based execution
      /powershell\s+-windowstyle\s+hidden/i,
      /powershell\s+-nop\s+-non/i,

      // Runkey persistence
      /runkey/i,
      /appinitdlls/i,
      /authorizedrun/i,

      // General payload decoding
      /convertfrom-base64string/i,
      /[regex]::unescape/i,

      // Encoded command injection
      /-encodedcommand/i,
      /-enc\s+"/,

      // Shell script detection (should not be in a PowerShell context)
      new RegExp('#!/usr/bin'),
      new RegExp('#!/bin')
    ];

    function validateScript(text) {
      if (!text) return { safe: true };
      const matches = DANGEROUS_PATTERNS
        .map((re) => text.match(re))
        .filter(Boolean);
      return {
        safe: matches.length === 0,
        matchedPatterns: matches.map((m) => m[0]),
      };
    }

// ---- Call Hugging Face Router API ----
    try {
      const hfResponse = await fetch(HF_ROUTER, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.HF_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'Qwen/Qwen2.5-72B-Instruct',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 2000,
          temperature: 0.7,
          stream: false
        }),
      });

      if (!hfResponse.ok) {
        const errText = await hfResponse.text();
        console.error('HF API Error:', hfResponse.status, errText);
        return new Response(JSON.stringify({ error: 'Upstream AI error' }), {
          status: 502,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const result = await hfResponse.json();
      const generatedText = result.choices?.[0]?.message?.content;

      // ---- Validate AI output before returning to client ----
      if (generatedText) {
        const validation = validateScript(generatedText);
        if (!validation.safe) {
          return new Response(JSON.stringify({
            error: 'Script contains a potentially dangerous pattern and was blocked.',
            blockedPatterns: validation.matchedPatterns.slice(0, 3),
          }), {
            status: 403,
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
      }

      if (!generatedText) {
        return new Response(JSON.stringify({ error: 'No response from AI model' }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // Basic sanitization: strip potential dangerous sequences (optional)
      const safeText = generatedText.replace(/<script[^>]*>.*?<\/script>/gi, '').trim();

      return new Response(JSON.stringify({ text: safeText }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      console.error('Worker unexpected error:', e.message || e);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },
};