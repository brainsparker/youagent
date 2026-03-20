/**
 * Email digest generation for YouAgent notifications.
 *
 * Generates structured digest content from recent posts and formats
 * it as HTML or plain text emails. Does not handle actual sending.
 */

import type { PostRepo } from '../storage/post-repo.js';

export interface EmailDigestConfig {
  frequency: 'daily' | 'weekly';
  /** Maximum number of findings to include in a digest. Default: 10 */
  maxPosts: number;
}

export interface DigestContent {
  agentHandle: string;
  period: string;
  topFindings: Array<{
    summary: string;
    sourceUrl: string;
    sourceAttribution: string;
  }>;
  respondCount: number;
  newFollowers: number;
  generatedAt: string;
}

export class EmailDigestService {
  constructor(private config: EmailDigestConfig) {}

  /**
   * Generate digest content from recent posts for a given agent.
   */
  async generateDigest(
    agentId: string,
    postRepo: PostRepo,
    since: Date,
  ): Promise<DigestContent> {
    const limit = this.config.maxPosts * 2; // fetch extra to filter by type
    const allPosts = postRepo.findByAgentId(agentId, limit, 0);

    const sinceMs = since.getTime();
    const recentPosts = allPosts.filter(
      (p) => new Date(p.timestamp).getTime() >= sinceMs,
    );

    const findings = recentPosts.filter((p) => p.type === 'finding');
    const responds = recentPosts.filter((p) => p.type === 'respond');

    const topFindings = findings.slice(0, this.config.maxPosts).map((p) => ({
      summary: p.summary,
      sourceUrl: p.sourceUrls[0] ?? '',
      sourceAttribution: p.sourceAttribution,
    }));

    const periodLabel =
      this.config.frequency === 'daily' ? 'Last 24 hours' : 'Last 7 days';

    return {
      agentHandle: agentId,
      period: periodLabel,
      topFindings,
      respondCount: responds.length,
      newFollowers: 0, // Placeholder until follower tracking emits events
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Format a digest as an HTML email.
   */
  formatAsHtml(digest: DigestContent): string {
    const findingsHtml = digest.topFindings
      .map(
        (f) => `
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #1a1a2e;">
          <p style="margin: 0 0 6px; color: #e0e0e0; font-size: 14px; line-height: 1.5;">${escapeHtml(f.summary)}</p>
          ${
            f.sourceUrl
              ? `<a href="${escapeHtml(f.sourceUrl)}" style="color: #38bdf8; font-size: 13px; text-decoration: none;">${escapeHtml(f.sourceAttribution || f.sourceUrl)}</a>`
              : ''
          }
        </td>
      </tr>`,
      )
      .join('\n');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>For You — ${escapeHtml(digest.period)} Digest</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 24px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td style="padding: 24px; text-align: center; border-bottom: 1px solid #1a1a2e;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.025em;">For You</h1>
              <p style="margin: 8px 0 0; color: #737373; font-size: 14px;">${escapeHtml(digest.period)} digest for ${escapeHtml(digest.agentHandle)}</p>
            </td>
          </tr>

          <!-- Stats -->
          <tr>
            <td style="padding: 20px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="text-align: center; padding: 12px;">
                    <div style="color: #38bdf8; font-size: 28px; font-weight: 700;">${digest.topFindings.length}</div>
                    <div style="color: #737373; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Findings</div>
                  </td>
                  <td style="text-align: center; padding: 12px;">
                    <div style="color: #a78bfa; font-size: 28px; font-weight: 700;">${digest.respondCount}</div>
                    <div style="color: #737373; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Responds</div>
                  </td>
                  <td style="text-align: center; padding: 12px;">
                    <div style="color: #34d399; font-size: 28px; font-weight: 700;">${digest.newFollowers}</div>
                    <div style="color: #737373; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">New Followers</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Findings -->
          ${
            digest.topFindings.length > 0
              ? `
          <tr>
            <td style="padding: 0 24px;">
              <h2 style="margin: 0 0 12px; color: #ffffff; font-size: 16px; font-weight: 600;">Top Findings</h2>
              <table width="100%" cellpadding="0" cellspacing="0">
                ${findingsHtml}
              </table>
            </td>
          </tr>`
              : ''
          }

          <!-- Footer -->
          <tr>
            <td style="padding: 24px; text-align: center; border-top: 1px solid #1a1a2e; margin-top: 24px;">
              <p style="margin: 0; color: #525252; font-size: 12px;">
                Generated ${escapeHtml(digest.generatedAt)} &middot; For You
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  /**
   * Format a digest as plain text.
   */
  formatAsText(digest: DigestContent): string {
    const divider = '─'.repeat(48);
    const lines: string[] = [];

    lines.push('FOR YOU');
    lines.push(`${digest.period} digest for ${digest.agentHandle}`);
    lines.push(divider);
    lines.push('');

    lines.push(
      `Findings: ${digest.topFindings.length}  |  Responds: ${digest.respondCount}  |  New Followers: ${digest.newFollowers}`,
    );
    lines.push('');

    if (digest.topFindings.length > 0) {
      lines.push('TOP FINDINGS');
      lines.push(divider);

      for (const finding of digest.topFindings) {
        lines.push('');
        lines.push(finding.summary);
        if (finding.sourceUrl) {
          lines.push(
            `  Source: ${finding.sourceAttribution || finding.sourceUrl}`,
          );
          lines.push(`  ${finding.sourceUrl}`);
        }
      }
    }

    lines.push('');
    lines.push(divider);
    lines.push(`Generated ${digest.generatedAt}`);

    return lines.join('\n');
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
