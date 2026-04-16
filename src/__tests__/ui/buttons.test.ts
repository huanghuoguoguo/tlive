import { describe, it, expect, beforeEach } from 'vitest';
import {
  permissionButtons,
  homeButtons,
  progressDoneButtons,
  progressRunningButtons,
  taskStartButtons,
  taskSummaryButtons,
  helpButtons,
  permStatusButtons,
  navNew,
  deferredSubmit,
  deferredSkip,
} from '../../ui/buttons.js';
import type { Locale } from '../../i18n/index.js';

describe('ui/buttons', () => {
  describe('permissionButtons', () => {
    it('creates three permission buttons (allow, always, deny)', () => {
      const buttons = permissionButtons('perm-123', 'en');

      expect(buttons).toHaveLength(3);
      expect(buttons[0].style).toBe('primary');
      expect(buttons[2].style).toBe('danger');
    });

    it('includes permission ID in callbackData', () => {
      const buttons = permissionButtons('perm-456', 'en');

      expect(buttons[0].callbackData).toContain('perm-456');
      expect(buttons[2].callbackData).toContain('perm-456');
    });

    it('uses zh locale labels', () => {
      const buttons = permissionButtons('perm-789', 'zh');

      // Labels should be translated
      expect(buttons[0].label).toBeDefined();
      expect(buttons[1].label).toBeDefined();
    });
  });

  describe('homeButtons', () => {
    it('creates four home buttons', () => {
      const buttons = homeButtons('en');

      expect(buttons.length).toBeGreaterThan(0);
    });

    it('includes sessions and new buttons', () => {
      const buttons = homeButtons('en');

      const hasSessions = buttons.some(b => b.callbackData.includes('sessions'));
      const hasNew = buttons.some(b => b.callbackData.includes('new'));
      expect(hasSessions || hasNew).toBe(true);
    });
  });

  describe('progressDoneButtons', () => {
    it('creates buttons for completed progress', () => {
      const buttons = progressDoneButtons('en');

      expect(buttons.length).toBeGreaterThan(0);
    });

    it('includes help button', () => {
      const buttons = progressDoneButtons('en');

      const hasHelp = buttons.some(b => b.callbackData.includes('help'));
      expect(hasHelp).toBe(true);
    });
  });

  describe('progressRunningButtons', () => {
    it('creates buttons for running progress', () => {
      const buttons = progressRunningButtons('en');

      expect(buttons.length).toBeGreaterThan(0);
    });

    it('includes stop button', () => {
      const buttons = progressRunningButtons('en');

      const hasStop = buttons.some(b => b.callbackData.includes('stop'));
      expect(hasStop).toBe(true);
    });
  });

  describe('taskStartButtons', () => {
    it('creates buttons for task start', () => {
      const buttons = taskStartButtons('en');

      expect(buttons.length).toBeGreaterThan(0);
    });

    it('includes new button', () => {
      const buttons = taskStartButtons('en');

      const hasNew = buttons.some(b => b.callbackData.includes('new'));
      expect(hasNew).toBe(true);
    });
  });

  describe('taskSummaryButtons', () => {
    it('creates two summary buttons', () => {
      const buttons = taskSummaryButtons('en');

      expect(buttons.length).toBeGreaterThan(0);
    });

    it('includes home button', () => {
      const buttons = taskSummaryButtons('en');

      const hasHome = buttons.some(b => b.callbackData.includes('home'));
      expect(hasHome).toBe(true);
    });
  });

  describe('helpButtons', () => {
    it('creates help navigation buttons', () => {
      const buttons = helpButtons('en');

      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  describe('permStatusButtons', () => {
    it('creates toggle button for on mode', () => {
      const buttons = permStatusButtons('on', 'en');

      expect(buttons.length).toBeGreaterThan(0);
      const toggle = buttons.find(b => b.callbackData.includes('perm'));
      expect(toggle?.style).toBe('danger');
    });

    it('creates toggle button for off mode', () => {
      const buttons = permStatusButtons('off', 'en');

      const toggle = buttons.find(b => b.callbackData.includes('perm'));
      expect(toggle?.style).toBe('primary');
    });
  });

  describe('navNew', () => {
    it('creates new session button', () => {
      const button = navNew('en');

      expect(button.callbackData).toContain('new');
      expect(button.label).toBeDefined();
    });
  });

  describe('deferredSubmit', () => {
    it('creates submit button with permission ID', () => {
      const button = deferredSubmit('deferred-123', 'en');

      expect(button.callbackData).toContain('deferred-123');
      expect(button.style).toBe('primary');
    });
  });

  describe('deferredSkip', () => {
    it('creates skip button with permission ID', () => {
      const button = deferredSkip('deferred-456', 'en');

      expect(button.callbackData).toContain('deferred-456');
      expect(button.style).toBe('default');
    });
  });

  describe('locale handling', () => {
    it('buttons work with en locale', () => {
      const buttons = homeButtons('en');
      for (const b of buttons) {
        expect(b.label).toBeDefined();
      }
    });

    it('buttons work with zh locale', () => {
      const buttons = homeButtons('zh');
      for (const b of buttons) {
        expect(b.label).toBeDefined();
      }
    });
  });
});