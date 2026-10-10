import type { ReactElement } from "react";
import { Button } from "antd";
import { CloseOutlined, MinusOutlined } from "@ant-design/icons";

interface WindowChromeProps {
  appLayout: boolean;
  friendsExpanded: boolean;
}

export function WindowChrome({ appLayout, friendsExpanded }: WindowChromeProps): ReactElement {
  const api = window.playerApi;
  return (
    <>
      <div className="player-window-drag-region" />
      <div className={`player-window-chrome${appLayout ? " player-window-chrome--app" : ""}${appLayout && !friendsExpanded ? " player-window-chrome--collapsed" : ""}`}>
        <div className="player-window-controls">
          <Button
            className="player-window-control"
            icon={<MinusOutlined />}
            type="text"
            onClick={() => void api.minimizeWindow()}
          />
          <Button
            className="player-window-control player-window-control--close"
            icon={<CloseOutlined />}
            type="text"
            onClick={() => void api.closeWindow()}
          />
        </div>
      </div>
    </>
  );
}
