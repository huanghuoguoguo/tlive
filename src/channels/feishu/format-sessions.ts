import { truncate } from '../../core/string.js';
import type { SessionDetailData, SessionsData } from '../../formatting/message-types.js';
import { t, type Locale } from '../../i18n/index.js';
import type { Button } from '../../ui/types.js';
import { buildFeishuButtonElements, type FeishuCardElement } from './card-builder.js';
import { mdElement } from './format-home.js';

export function buildSessionsElements(data: SessionsData, locale: Locale): FeishuCardElement[] {
  const showAll = data.showAll ?? false;
  const title = showAll ? t(locale, 'sessions.btnAll') : t(locale, 'sessions.btnRecent');
  const subtitle = showAll
    ? t(locale, 'sessions.subtitleAll')
    : t(locale, 'sessions.subtitleRecent');
  const elements: FeishuCardElement[] = [mdElement(`**${title}** ${subtitle}`)];

  const toggleButton: Button = showAll
    ? {
        label: t(locale, 'sessions.btnRecent'),
        callbackData: 'cmd:session',
        style: 'primary',
        row: 0,
      }
    : {
        label: t(locale, 'sessions.btnAll'),
        callbackData: 'cmd:session --all',
        style: 'default',
        row: 0,
      };
  elements.push(...buildFeishuButtonElements([toggleButton]));

  for (const s of data.sessions) {
    const marker = s.isCurrent ? t(locale, 'sessions.currentMarker') : '';
    const providerLabel = s.providerDisplayName ?? 'Agent';
    const cwdDisplay = showAll ? `**${t(locale, 'sessions.labelDirectory')}**\n\`${s.cwd}\`\n` : '';
    const headerText = `${s.index}. ${providerLabel} · ${s.date} · ${truncate(s.preview, 35)}${marker}`;
    const panelContent: FeishuCardElement[] = [
      mdElement(
        `**引擎**\n${providerLabel}\n${cwdDisplay}**${t(locale, 'sessions.labelTime')}**\n${s.date}\n**${t(locale, 'sessions.labelSize')}**\n${s.size}\n**${t(locale, 'sessions.labelPreview')}**\n${truncate(s.preview, 200)}`,
      ),
    ];
    const switchBtn: Button = {
      label: `${t(locale, 'sessions.switchTo')} #${s.index}`,
      callbackData: `cmd:session ${s.index}`,
      style: s.isCurrent ? 'primary' : 'default',
      row: 0,
    };
    panelContent.push(...buildFeishuButtonElements([switchBtn]));
    elements.push({
      tag: 'collapsible_panel',
      expanded: s.isCurrent,
      header: { title: { tag: 'plain_text', content: headerText } },
      elements: panelContent,
    } as FeishuCardElement);
  }

  const formElements: FeishuCardElement[] = [
    {
      tag: 'input',
      name: '_session_idx',
      placeholder: { tag: 'plain_text', content: t(locale, 'sessions.inputPlaceholder') },
      required: false,
    } as FeishuCardElement,
  ];
  const formButtons: Button[] = [
    {
      label: t(locale, 'sessions.btnConfirmSwitch'),
      callbackData: 'form:session_select',
      style: 'primary',
      row: 0,
    },
  ];
  elements.push({
    tag: 'form',
    name: 'form_session_select',
    elements: [
      ...(formElements as unknown as { tag: string; content: string }[]),
      ...(buildFeishuButtonElements(formButtons) as unknown as { tag: string; content: string }[]),
    ],
  } as FeishuCardElement);

  return elements;
}

export function buildSessionDetailElements(
  data: SessionDetailData,
  locale: Locale,
): FeishuCardElement[] {
  const elements: FeishuCardElement[] = [
    mdElement(`**引擎**\n${data.providerDisplayName ?? 'Agent'}`),
    mdElement(`**${t(locale, 'sessions.labelDirectory')}**\n\`${data.cwd}\``),
    mdElement(`**${t(locale, 'sessions.labelTime')}**\n${data.date}`),
    mdElement(`**${t(locale, 'sessions.labelSize')}**\n${data.size}`),
    mdElement(`**${t(locale, 'sessions.labelPreview')}**\n${data.preview}`),
  ];
  if (data.transcript.length > 0) {
    const transcriptLines = data.transcript.slice(0, 4).map((entry) => {
      const role = entry.role === 'user' ? '👤' : '🤖';
      return `${role} ${truncate(entry.text, 100)}`;
    });
    elements.push(
      mdElement(`**${t(locale, 'home.labelRecentChat')}**\n${transcriptLines.join('\n')}`),
    );
  }
  return elements;
}
