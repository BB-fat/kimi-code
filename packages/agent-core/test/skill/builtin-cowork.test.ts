import { describe, expect, it } from 'vitest';

import { COWORK_SKILL, SessionSkillRegistry, registerBuiltinSkills } from '../../src/skill';

describe('builtin skill: cowork', () => {
  it('has the expected identity and inline metadata', () => {
    expect(COWORK_SKILL.name).toBe('cowork');
    expect(COWORK_SKILL.source).toBe('builtin');
    expect(COWORK_SKILL.description.length).toBeGreaterThan(0);
    expect(COWORK_SKILL.metadata.type).toBe('inline');
  });

  it('is hidden from model invocation (user starts cowork explicitly)', () => {
    expect(COWORK_SKILL.metadata.disableModelInvocation).toBe(true);
  });

  it('defines the three roles and routes every protocol action through Cowork tools', () => {
    const content = COWORK_SKILL.content;
    expect(content).toContain('**The tower**');
    expect(content).toContain('**Workers and reviewers**');
    for (const tool of [
      'CoworkInit',
      'CoworkPlan',
      'CoworkSpawn',
      'CoworkSend',
      'CoworkInbox',
      'CoworkFinding',
      'CoworkReview',
      'CoworkMission',
      'CoworkMerge',
      'CoworkStatus',
      'CoworkTeardown',
    ]) {
      expect(content).toContain(tool);
    }
  });

  it('declares the protocol code-enforced and forbids hand-written comms files', () => {
    const content = COWORK_SKILL.content;
    expect(content).toContain('enforced by tools, not by instructions');
    expect(content).toContain('Never create or edit files under `.cowork/` by hand');
    expect(content).toContain('log/activity.log');
  });

  it('never blocks on human approval — no gates, inform and proceed', () => {
    const content = COWORK_SKILL.content;
    expect(content).toContain('Never block on the human');
    expect(content).not.toContain('wait for explicit approval');
  });

  it('lets workers negotiate peer-to-peer instead of tower relay', () => {
    const content = COWORK_SKILL.content;
    expect(content).toContain('Agents negotiate internally');
    expect(content).toContain('not a content relay');
  });

  it('initializes git itself for empty dirs but never blind-commits user files', () => {
    const content = COWORK_SKILL.content;
    expect(content).toContain('git commit --allow-empty');
    expect(content).toContain('never `git add -A`');
    expect(content).toContain('exactly once');
  });

  it('keeps merge decisions behind CoworkMerge and re-review after rebase', () => {
    const content = COWORK_SKILL.content;
    expect(content).toContain('CoworkMerge(branch)');
    expect(content).toContain('rebase');
    expect(content).toContain('Dependency Flow');
  });

  it('tells the tower to teardown promptly once every mission is merged', () => {
    const content = COWORK_SKILL.content;
    expect(content).toContain('Teardown promptly');
    expect(content).toContain('CoworkTeardown');
    expect(content).toContain('right away');
  });

  it('registers through registerBuiltinSkills but stays out of the model skill listing', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    expect(registry.getSkill('cowork')).toBeDefined();
    expect(registry.listInvocableSkills().some((skill) => skill.name === 'cowork')).toBe(false);
    expect(registry.listSkills().some((skill) => skill.name === 'cowork')).toBe(true);
  });

  it('expands $ARGUMENTS as the user objective when rendering', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);
    const skill = registry.getSkill('cowork');
    expect(skill).toBeDefined();

    const rendered = registry.renderSkillPrompt(skill!, 'split auth and ui refactors');
    expect(rendered).toContain('split auth and ui refactors');
  });
});
