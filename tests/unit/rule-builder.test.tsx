// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RuleBuilder, countConditions } from '../../src/web/components/RuleBuilder';
import type { ConditionGroup } from '../../src/shared/types';

const initial: ConditionGroup = {
  kind: 'group',
  op: 'AND',
  children: [
    {
      kind: 'condition',
      id: 'c1',
      timeframe: '5m',
      left: { series: 'price.low' },
      cmp: 'lte',
      right: { type: 'series', series: 'bb.lower', params: { length: 20, mult: 2 } },
    },
  ],
};

function Harness() {
  const [expression, setExpression] = useState(initial);
  return (
    <div>
      <span data-testid="count">{countConditions(expression)}</span>
      <RuleBuilder expression={expression} onChange={setExpression} preview={new Map()} />
    </div>
  );
}

describe('RuleBuilder', () => {
  it('edits series, comparator, logic mode and adds/removes conditions', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByLabelText('条件 1 指标')).toHaveValue('price.low');

    await user.selectOptions(screen.getByLabelText('条件 1 指标'), 'kdj.j');
    expect(screen.getByLabelText('条件 1 指标')).toHaveValue('kdj.j');
    await user.selectOptions(screen.getByLabelText('条件 1 比较符'), 'gte');
    expect(screen.getByLabelText('条件 1 比较符')).toHaveValue('gte');
    await user.selectOptions(screen.getByLabelText('条件组逻辑'), 'OR');
    expect(screen.getByLabelText('条件组逻辑')).toHaveValue('OR');

    await user.click(screen.getAllByTestId('add-condition')[0]);
    expect(screen.getByTestId('count')).toHaveTextContent('2');
    expect(screen.getAllByLabelText(/删除条件/)).toHaveLength(2);
    await user.click(screen.getAllByLabelText('删除条件')[0]);
    expect(screen.getByTestId('count')).toHaveTextContent('1');
  });

  it('creates a nested group and respects the maximum condition count', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getAllByTestId('add-group')[0]);
    // The nested group adds a default condition.
    expect(screen.getByTestId('count')).toHaveTextContent('2');
    for (let i = 0; i < 20; i++) {
      const buttons = screen.getAllByTestId('add-condition');
      if (!buttons[0].hasAttribute('disabled')) await user.click(buttons[0]);
      else break;
    }
    expect(Number(screen.getByTestId('count').textContent)).toBeLessThanOrEqual(12);
  });
});
