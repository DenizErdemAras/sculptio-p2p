import { useContext, useMemo, useState } from 'react';
import { X, Plus } from 'lucide-react';
import { UserContext } from '../contexts/UserContext';
import ScrollableList from './ScrollableList';
import { HiddenTextInput } from './InputElements';
import { Pencil } from 'lucide-react';

interface WordListEditorProps {
  onClose: () => void;
}

type Difficulty = 'easy' | 'medium' | 'hard';
type ModalView = 'select-list' | 'edit-list';

type CustomWordList = {
  id: string;
  name: string;
  easy: string[];
  medium: string[];
  hard: string[];
};

// const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

const createId = () => {
  if (crypto.randomUUID) return crypto.randomUUID();

  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
};

const createEmptyWordList = (): CustomWordList => {
  return {
    id: createId(),
    name: 'New Word List',
    easy: [],
    medium: [],
    hard: []
  };
};

const getWordCount = (words: unknown) => {
  if (!Array.isArray(words)) return 0;

  return words.filter(word => String(word ?? '').trim().length > 0).length;
};

const isUsableWordList = (list: CustomWordList) => {
  return (
    getWordCount(list.easy) >= 10 &&
    getWordCount(list.medium) >= 10 &&
    getWordCount(list.hard) >= 10
  );
};

const normalizeWordList = (list: any): CustomWordList => {
  return {
    id: String(list?.id ?? createId()),
    name: String(list?.name ?? 'Untitled List'),
    easy: Array.isArray(list?.easy) ? list.easy : [],
    medium: Array.isArray(list?.medium) ? list.medium : [],
    hard: Array.isArray(list?.hard) ? list.hard : []
  };
};

export default function WordListEditor({ onClose }: WordListEditorProps) {
  const { userData, updateUserData } = useContext(UserContext);

  const [modalView, setModalView] = useState<ModalView>('select-list');
  const [editingListId, setEditingListId] = useState<string | null>(null);

  const [wordInputs, setWordInputs] = useState<Record<Difficulty, string>>({
    easy: '',
    medium: '',
    hard: ''
  });

  const customWordLists: CustomWordList[] = useMemo(() => {
    const lists = userData?.preferences?.customWordLists;

    if (!Array.isArray(lists)) return [];

    return lists.map(normalizeWordList);
  }, [userData?.preferences?.customWordLists]);

  const editingList = customWordLists.find(list => list.id === editingListId) ?? null;

  const saveCustomWordLists = async (lists: CustomWordList[]) => {
    await updateUserData({
      preferences: {
        ...(userData.preferences ?? {}),
        customWordLists: lists
      }
    });
  };

  const updateWordList = async (
    listId: string,
    updater: (list: CustomWordList) => CustomWordList
  ) => {
    const updatedLists = customWordLists.map(list => {
      if (list.id !== listId) return list;

      return updater(list);
    });

    await saveCustomWordLists(updatedLists);
  };

  const handleAddNewList = async () => {
    const newList = createEmptyWordList();

    await saveCustomWordLists([
      ...customWordLists,
      newList
    ]);

    setEditingListId(newList.id);
    setModalView('edit-list');
  };

  const handleEditList = (listId: string) => {
    setEditingListId(listId);
    setModalView('edit-list');
  };

  const handleRenameList = async (name: string) => {
    if (!editingList) return;

    await updateWordList(editingList.id, list => ({
      ...list,
      name: name || 'Untitled List'
    }));
  };

  const handleAddWord = async (difficulty: Difficulty) => {
    if (!editingList) return;

    const word = wordInputs[difficulty].trim();
    if (!word) return;

    await updateWordList(editingList.id, list => {
      const currentWords = list[difficulty] ?? [];

      if (currentWords.some(existing => existing.toLocaleLowerCase('tr-TR') === word.toLocaleLowerCase('tr-TR'))) {
        return list;
      }

      return {
        ...list,
        [difficulty]: [...currentWords, word]
      };
    });

    setWordInputs(prev => ({
      ...prev,
      [difficulty]: ''
    }));
  };

  const handleRemoveWord = async (difficulty: Difficulty, wordIndex: number) => {
    if (!editingList) return;

    await updateWordList(editingList.id, list => ({
      ...list,
      [difficulty]: list[difficulty].filter((_, index) => index !== wordIndex)
    }));
  };

  const handleDeleteList = async (listId: string) => {
    const updatedLists = customWordLists.filter(list => list.id !== listId);

    await saveCustomWordLists(updatedLists);

    if (editingListId === listId) {
        setEditingListId(null);
        setModalView('select-list');
    }
};

  const renderSelectListView = () => {
    return (
      <>
        <h2>Word Lists</h2>

        <div className="config-section flex-column centered">
          <h3 className="section-title">Custom Word Lists</h3>

          <div className="grid-full-row width-100 centered" style={{ gridColumn: '1 / -1', minWidth: '400px' }}>
            <button
              className="mid submit width-100"
              onClick={handleAddNewList}
            >
              Add New Word List
            </button>
          </div>

          {customWordLists.length > 0 ? (
            <div className="width-100 flex-column gap-4">
              <ScrollableList
                items={customWordLists}
                renderItem={(list: CustomWordList) => {
                  const usable = isUsableWordList(list);

                  return (
                    <div
                      key={list.id}
                      className={`card ${usable ? '' : 'red'} flex-row `}
                    > 
                      <div className='flex-column flex-grow  gap-2'>
                        <div className="flex-row centered space-between gap-6">
                          <span>{list.name || 'Untitled List'}</span>

                          
                        </div>

                        <div className="flex-row gap-6 grey-text">
                          <span>Easy: {getWordCount(list.easy)}</span>
                          <span>Medium: {getWordCount(list.medium)}</span>
                          <span>Hard: {getWordCount(list.hard)}</span>
                        </div>

                        {!usable && (
                          <span className="warning-text">
                            Needs at least 10 words in each difficulty.
                          </span>
                        )}
                      </div>

                      <div className='flex-column gap-6'>
                        <button
                          className="light pad-4"
                          onClick={() => handleEditList(list.id)}
                        >
                          <Pencil size={18} />
                        </button>

                        <button
                          className="red pad-4"
                          onClick={() => handleDeleteList(list.id)}
                        >
                          <X size={18} />
                        </button>
                      </div>
                    </div>
                  );
                }}
              />
            </div>
          ) : (
            <span className="grey-text grid-full-row">
              No custom word lists yet.
            </span>
          )}
        </div>

        <div className="modal-footer">
          <button className="mid light" onClick={onClose}>
            Back
          </button>
        </div>
      </>
    );
  };

  const renderWordSection = (difficulty: Difficulty) => {
    if (!editingList) return null;

    const words = editingList[difficulty] ?? [];
    const title = difficulty.charAt(0).toUpperCase() + difficulty.slice(1);

    return (
      <div className="flex-column flex-grow gap-6">
        <h3>{title}</h3>

        <div className="flex-row gap-6">
          <input
            type="text"
            className="config-input flex-grow"
            value={wordInputs[difficulty]}
            placeholder={`Add ${difficulty} word`}
            onChange={(e) => {
              setWordInputs(prev => ({
                ...prev,
                [difficulty]: e.target.value
              }));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void handleAddWord(difficulty);
              }
            }}
          />

          <button
            className="submit pad-4"
            onClick={() => handleAddWord(difficulty)}
          >
            <Plus size={22} />
          </button>
        </div>

        <span className="grey-text">
          Words: {getWordCount(words)}
        </span>

        <ScrollableList
          items={words}
          renderItem={(word: string, index: number) => (
            <div
              key={`${difficulty}-${word}-${index}`}
              className="flex-row card gap-6 centered"
            >
              <span className="flex-grow">
                {word}
              </span>

              <button
                className="red pad-2"
                onClick={() => handleRemoveWord(difficulty, index)}
              >
                <X size={14} />
              </button>
            </div>
          )}
        />
      </div>
    );
  };

  const renderEditListView = () => {
    if (!editingList) {
      return (
        <>
          <h2>Word List Not Found</h2>

          <div className="modal-footer">
            <button
              className="mid light"
              onClick={() => setModalView('select-list')}
            >
              Back
            </button>
          </div>
        </>
      );
    }

    return (
      <>
        <div className="flex-column centered space-between gap-6">
          <HiddenTextInput
            className="modal-title"
            inputClassName="modal-title"
            value={editingList.name}
            placeholder="Word List Name"
            maxLength={40}
            onChange={handleRenameList}
          />

          <span className={isUsableWordList(editingList) ? 'grey-text' : 'warning-text'}>
            {isUsableWordList(editingList)
              ? 'Usable in rooms'
              : 'Needs at least 10 words in each difficulty'}
          </span>
        </div>

        <div className="flex-row gap-6 width-100">
          {renderWordSection('easy')}
          {renderWordSection('medium')}
          {renderWordSection('hard')}
        </div>

        <div className="modal-footer">
          <button
            className="mid light"
            onClick={() => setModalView('select-list')}
          >
            Back
          </button>
        </div>
      </>
    );
  };

  return (
    <div className="modal-overlay" onClick={modalView === 'select-list' ? onClose : undefined}>
      <div className="modal-content panel" onClick={(e) => e.stopPropagation()}>
        {modalView === 'select-list'
          ? renderSelectListView()
          : renderEditListView()}
      </div>
    </div>
  );
}