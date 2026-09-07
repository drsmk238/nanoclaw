/**
 * Which outbound messages quote the message they answer.
 *
 * WhatsApp has no subjects and no threads, so a reply is just another message
 * in the chat. When several scheduled runs answer at once, nothing says which
 * question each belongs to — quoting supplies that, and only where it is
 * needed.
 */
import { describe, it, expect } from 'vitest';

import { quotableMessageId } from './whatsapp.js';

describe('quotableMessageId', () => {
  it('recovers the chat message id from a reply to an inbound message', () => {
    expect(quotableMessageId('3EB0C6E5A903D104BF2818:ag-1788625605264-zt8hdp')).toBe('3EB0C6E5A903D104BF2818');
  });

  it('accepts a bare chat message id', () => {
    expect(quotableMessageId('3EB0C6E5A903D104BF2818')).toBe('3EB0C6E5A903D104BF2818');
  });

  it('refuses an agent-to-agent handoff — it answers nothing in this chat', () => {
    expect(quotableMessageId('a2a-1788759980696-tmhvk5')).toBeNull();
  });

  it('refuses a task run and an echoed message', () => {
    expect(quotableMessageId('task-1788694283403-7bcix5')).toBeNull();
    expect(quotableMessageId('msg-1788760133645-156fbo:echo:sess-1788672164199-30dho1')).toBeNull();
  });

  it('refuses nothing at all', () => {
    expect(quotableMessageId(null)).toBeNull();
    expect(quotableMessageId(undefined)).toBeNull();
    expect(quotableMessageId('')).toBeNull();
  });
});
