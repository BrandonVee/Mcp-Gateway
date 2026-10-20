import { useEffect, useRef, useState } from 'react';
import { AutoComplete, Input } from 'antd';
import { useI18n } from '@/web/i18n';
import type { UsageFilters } from '@/web/types';

interface ToolSearchInputProps {
  id?: string;
  value?: string;
  onChange?: (value: string) => void;
  filters: UsageFilters;
  loadTools: (filters: UsageFilters, search: string) => Promise<{ tools: string[] }>;
  onCommit: (value: string, match: 'exact' | 'contains') => void;
}

const signature = (value: string, match: string) => JSON.stringify([value.trim(), match]);

export function ToolSearchInput({ id, value = '', onChange, filters, loadTools, onCommit }: ToolSearchInputProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState<string | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const draft = useRef(value);
  const selected = useRef<string | null>(null);
  const navigating = useRef(false);
  const submitted = useRef(signature(filters.tool ?? '', filters.tool_match ?? 'contains'));
  const commitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const scope = JSON.stringify(filters);

  useEffect(() => {
    draft.current = value;
    if (selected.current !== value) selected.current = null;
  }, [value]);
  useEffect(() => {
    submitted.current = signature(filters.tool ?? '', filters.tool_match ?? 'contains');
  }, [filters.tool, filters.tool_match]);
  useEffect(() => () => clearTimeout(commitTimer.current), []);
  useEffect(() => {
    setTools([]);
    if (search === null) return;
    let active = true;
    const timer = setTimeout(() => {
      void loadTools(filters, search.trim()).then(
        (result) => {
          if (active) setTools(result.tools);
        },
        () => {
          if (active) setTools([]);
        },
      );
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search, scope, loadTools]);

  const submit = (next: string, match: 'exact' | 'contains') => {
    clearTimeout(commitTimer.current);
    // Selection, blur and Enter can happen together; commit the final choice once.
    commitTimer.current = setTimeout(() => {
      const key = signature(next, match);
      if (submitted.current === key) return;
      submitted.current = key;
      commit.current(next.trim(), match);
    }, 0);
  };
  const finish = () => {
    navigating.current = false;
    setSearch(null);
    submit(draft.current, selected.current === draft.current ? 'exact' : 'contains');
  };

  return (
    <AutoComplete
      id={id}
      value={value}
      style={{ width: '100%' }}
      options={tools.map((tool) => ({ value: tool }))}
      defaultActiveFirstOption={false}
      filterOption={false}
      onSearch={(next) => {
        navigating.current = false;
        setSearch(next);
      }}
      onInputKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') navigating.current = true;
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && (!navigating.current || tools.length === 0)) {
          event.preventDefault();
          event.stopPropagation();
          finish();
        }
      }}
      onChange={(next) => {
        draft.current = next;
        selected.current = null;
        onChange?.(next);
      }}
      onSelect={(next) => {
        navigating.current = false;
        selected.current = next;
        setSearch(null);
        submit(next, 'exact');
      }}
      onBlur={finish}
    >
      <Input
        allowClear
        maxLength={128}
        placeholder={t('usage.toolPlaceholder')}
        onClear={() => {
          setSearch(null);
          submit('', 'contains');
        }}
      />
    </AutoComplete>
  );
}
