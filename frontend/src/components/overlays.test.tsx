import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { Modal } from './overlays';
import { TextArea, TextField } from './ui';

/** Reproduces a "create" dialog: controlled fields plus the inline onClose every caller passes. */
function QuizCreateDialog() {
  const [open, setOpen] = useState(true);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="New quiz">
      <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <TextArea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
    </Modal>
  );
}

describe('Modal', () => {
  it('keeps focus and values in the field being edited while typing', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <QuizCreateDialog />
      </I18nProvider>,
    );

    const title = screen.getByLabelText('Title');
    const description = screen.getByLabelText('Description');

    // Typing in the description must not jump focus back to the title (a re-render must not
    // re-run the modal's focus effect).
    await user.click(description);
    await user.type(description, 'A quiz about greetings');
    expect(description).toHaveFocus();
    expect(description).toHaveValue('A quiz about greetings');

    // The title keeps its own independent value.
    await user.click(title);
    await user.type(title, 'Greetings 101');
    expect(title).toHaveFocus();
    expect(title).toHaveValue('Greetings 101');
    expect(description).toHaveValue('A quiz about greetings');
  });
});
