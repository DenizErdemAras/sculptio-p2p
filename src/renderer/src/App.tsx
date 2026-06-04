import { useContext } from 'react';
import { UserProvider } from './contexts/UserContext';
import { UIProvider, UIContext } from './contexts/UIContext';
import { NetworkProvider, NetworkContext } from './contexts/NetworkContext';
import { GameProvider } from './contexts/GameContext';
import TitleBar from './components/TitleBar';
import Lobby from './pages/Lobby';
import MainMenu from './pages/MainMenu';
import Room from './pages/Room';
import Sandbox from './pages/Sandbox';
import './assets/colors.css';

const Router = () => {
  const ui = useContext(UIContext);
  const network = useContext(NetworkContext);
  
  if (!ui) {
    console.log('User Interface contex not found')
    return null
  };
  
  console.log(ui.view);
  switch (ui.view) {
    case 'menu':
      if (network.status === 'creating_room') {
        return <div className="centered white">Creating Room...</div>;
      }
      return <MainMenu />;
    
    case 'lobby':
      if (network.status === 'connecting') {
        return <div className="centered white">Connecting to Lobby...</div>;
      }
      if (network.status === 'creating_room') {
        return <div className="centered white">Creating Room...</div>;
      }
      return <Lobby />;

    case 'room':
      return <Room />;

    case 'sandbox':
      return <Sandbox />;

    default:
      return <MainMenu />;
  }
};

const AlertLayer = () => {
    const ui = useContext(UIContext);

    if (!ui) return null;

    return (
        <div className="alert-layer flex-column">
            {ui.alerts.map(alert => (
                <div
                    key={alert.id}
                    className="alert-card"
                    onClick={() => ui.dismissAlert(alert.id)}
                >
                    <strong>{alert.title}</strong>
                    {alert.message && <p>{alert.message}</p>}
                </div>
            ))}
        </div>
    );
};

export default function App() {
  return (
    <UIProvider>
      <UserProvider>
        <NetworkProvider>
          <GameProvider>
            <TitleBar />
            <div className='application-window'>
              <Router />
            </div>
            <AlertLayer />
          </GameProvider>
        </NetworkProvider>
      </UserProvider>
    </UIProvider>
  );
}