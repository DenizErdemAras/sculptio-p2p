// src/renderer/src/components/ScrollableList.tsx
import "../assets/ScrollableList.css"
import { useRef, useEffect } from 'react';

interface ScrollableListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  reversed?: boolean;
}

export default function ScrollableList<T>({ items, renderItem, reversed }: ScrollableListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);

  const handleScroll = () => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    
    // Check if we are within 10px of the bottom
    isAtBottom.current = scrollHeight - scrollTop - clientHeight <= 10;
  };

  useEffect(() => {
    if (isAtBottom.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [items]);

  return (
    <div className='message-window bg' style={{flexDirection: reversed ? 'column' : 'column-reverse', justifyContent: reversed ? 'end' : 'start'}}>
      <div 
        className='message-list' 
        style={{flexDirection: reversed ? 'column' : 'column-reverse'}}
        ref={listRef} 
        onScroll={handleScroll}
      >
        {items.map((item, index) => renderItem(item, index))}
      </div>
    </div>
  );
}