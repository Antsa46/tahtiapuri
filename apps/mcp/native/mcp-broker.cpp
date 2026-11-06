#include "broker-worker.h"
#include "broker-relay.h"
#include "main-peer.h"

namespace {
using namespace mcp_runtime;
void diagnostic(HANDLE pipe,const std::string& reason,DWORD error){
    std::string safe;for(char c:reason){if(safe.size()==80)break;if((c>='a'&&c<='z')||c=='-')safe+=c;}
    const auto message="{\"stage\":\""+(safe.empty()?std::string("internal"):safe)+"\",\"code\":"+std::to_string(error)+"}\n";
    BrokerWriter output(pipe,false,1);output.bytes({message.begin(),message.end()});const auto end=clockNow()+2000;
    while(!output.idle()&&!output.failed()&&clockNow()<end)Sleep(2);output.stop();
}
}
int wmain(int argc,wchar_t** argv){
    using namespace mcp_runtime;
    // Fixed Main descriptor only: no worker path, policy selector or extra args.
    if(argc!=2)return 64;
    BrokerWatchdog watchdog;watchdog.deadline.store(clockNow()+45000);
    try{
        BrokerOwnerPipes pipes;
        std::unique_ptr<BootstrapDirectoryGuard> control;
        std::unique_ptr<VerifiedMainPipe> main;
        std::unique_ptr<BrokerResources> resources;
        std::unique_ptr<BrokerJournal> journal;
        std::unique_ptr<BrokerWorker> worker;
        std::unique_ptr<BrokerWriter> mainWriter,workerWriter,hostWriter;
        std::unique_ptr<BrokerRelay> relay;
        BrokerReader mainReader(Direction::FromMain),workerReader(Direction::FromWorker);
        bool failed=false,clean=false,mainPresent=false,requestedStop=false,workerOutputEnded=false;size_t stderrBytes=0;
        std::string reason="none";DWORD error=0;
        std::function<void()> pollMain;
        try{
            auto bootstrap=readMainBootstrapFile(argv[1]);control=std::make_unique<BootstrapDirectoryGuard>(argv[1]);
            main=std::make_unique<VerifiedMainPipe>(bootstrap);mainPresent=true;const HANDLE channel=main->channel();
            mainWriter=std::make_unique<BrokerWriter>(channel,true,8);hostWriter=std::make_unique<BrokerWriter>(pipes.output.value,false,16);
            relay=std::make_unique<BrokerRelay>(bootstrap,[&](BrokerFrame frame){mainWriter->frame(Direction::ToMain,std::move(frame));},
                [&](BrokerFrame frame){if(!workerWriter)throw WireError("worker-writer-unavailable");workerWriter->frame(Direction::ToWorker,std::move(frame));},
                [&](Bytes bytes){hostWriter->bytes(std::move(bytes));});
            pollMain=[&,channel]{
                if(WaitForSingleObject(main->lifetime(),0)!=WAIT_TIMEOUT){mainPresent=false;throw WinError("mcp-main-exit",ERROR_PROCESS_ABORTED);}
                mainWriter->check(clockNow());mainReader.check(clockNow());
                if(!pollPipe(channel,true,65536,[&](const uint8_t* bytes,size_t size){mainReader.write(bytes,size,clockNow(),[&](BrokerFrame frame){relay->main(std::move(frame));});})){
                    mainPresent=false;mainReader.end();throw WinError("mcp-main-eof",ERROR_BROKEN_PIPE);
                }
            };
            Bytes hello;hello.insert(hello.end(),bootstrap.generation.begin(),bootstrap.generation.end());hello.insert(hello.end(),bootstrap.launchToken.begin(),bootstrap.launchToken.end());
            mainWriter->frame(Direction::ToMain,{1,std::move(hello)});SecureZeroMemory(bootstrap.launchToken.data(),bootstrap.launchToken.size());
            const auto authenticationEnd=clockNow()+3000;
            while(!relay->accepted()){
                pollMain();if(clockNow()>=authenticationEnd)throw WinError("mcp-authentication-timeout",ERROR_TIMEOUT);Sleep(2);
            }
            resources=std::make_unique<BrokerResources>(*control);journal=std::make_unique<BrokerJournal>(*control,*resources,bootstrap);
            auto ownerAlive=[&]{pollMain();if(relay->stopping()){requestedStop=true;throw WinError("mcp-main-stop",ERROR_OPERATION_ABORTED);}};
            worker=std::make_unique<BrokerWorker>(*resources,*journal,pipes,ownerAlive);worker->prepare();
            workerWriter=std::make_unique<BrokerWriter>(worker->input.value,false,16);worker->start();
            const auto readyEnd=clockNow()+10000;bool observedReady=false;
            while(!relay->stopping()){
                watchdog.deadline.store(clockNow()+5000);pollMain();if(relay->stopping()){requestedStop=true;break;}
                const auto now=clockNow();workerWriter->check(now);hostWriter->check(now);workerReader.check(now);relay->check(now);
                if(!pollPipe(worker->output.value,false,65536,[&](const uint8_t* bytes,size_t size){workerReader.write(bytes,size,clockNow(),[&](BrokerFrame frame){relay->worker(std::move(frame),clockNow());});})){
                    workerReader.end();relay->workerEnd();workerOutputEnded=true;throw WinError("mcp-worker-eof",ERROR_BROKEN_PIPE);
                }
                pollPipe(worker->error.value,false,1024,[&](const uint8_t*,size_t size){stderrBytes+=size;if(stderrBytes>16384)throw WinError("mcp-stderr-bound",ERROR_BUFFER_OVERFLOW);});
                if(worker->exited())throw WinError("mcp-unexpected-worker-exit",ERROR_PROCESS_ABORTED);
                if(relay->ready()&&!observedReady){worker->checkConsole();observedReady=true;}
                if(!observedReady&&now>=readyEnd)throw WinError("mcp-worker-ready-timeout",ERROR_TIMEOUT);
                if(observedReady&&!pollPipe(pipes.input.value,false,16384,[&](const uint8_t* bytes,size_t size){relay->host(Bytes(bytes,bytes+size));})){
                    requestedStop=true;relay->stop();break;
                }
                Sleep(2);
            }
        }catch(const WinError& e){failed=!(requestedStop&&std::string(e.what())=="mcp-main-stop");reason=e.what();error=e.code;}
         catch(const JournalError& e){failed=true;reason=e.what();error=ERROR_INVALID_DATA;}
         catch(const WireError& e){failed=true;reason=e.what();error=ERROR_INVALID_DATA;}
         catch(...){failed=true;reason="mcp-internal";error=ERROR_UNHANDLED_EXCEPTION;}

        // All paths stop admission. The hard cleanup deadline never depends on
        // a worker acknowledgement, stdout drain or a cooperating MCP host.
        watchdog.deadline.store(clockNow()+12000);if(relay)relay->stop();
        if(worker&&worker->resumed&&workerWriter&&!failed){
            try{
                workerWriter->frame(Direction::ToWorker,{3,{}});const auto end=clockNow()+2000;
                awaitWorkerClose(worker->output.value,worker->error.value,workerReader,workerOutputEnded,
                    *workerWriter,stderrBytes,[&]{return worker->exited();},end);
                if(worker->exitCode!=0)throw WinError("mcp-worker-close-exit",ERROR_PROCESS_ABORTED);
            }catch(const WinError& e){failed=true;reason=e.what();error=e.code;}
             catch(...){failed=true;reason="mcp-worker-close";error=ERROR_INVALID_DATA;}
        }
        // Stop writers before closing their handles or deleting worker files.
        if(workerWriter){workerWriter->stop();workerWriter.reset();}if(hostWriter){hostWriter->stop();hostWriter.reset();}
        if(worker){closeNative(worker->input);closeNative(worker->output);closeNative(worker->error);
            try{worker->cleanup();clean=true;}catch(const WinError& e){failed=true;reason=e.what();error=e.code;}catch(...){failed=true;reason="mcp-cleanup";error=ERROR_UNHANDLED_EXCEPTION;}
        }
        if(clean&&mainPresent&&mainWriter){
            try{
                main->verify();mainWriter->frame(Direction::ToMain,{6,{}});const auto end=clockNow()+2000;
                while(!mainWriter->idle()){mainWriter->check(clockNow());if(clockNow()>=end)throw WinError("mcp-clean-timeout",ERROR_TIMEOUT);Sleep(2);}
            }catch(const WinError& e){failed=true;reason=e.what();error=e.code;}catch(...){failed=true;reason="mcp-clean-write";error=ERROR_INVALID_DATA;}
        }
        if(mainWriter){mainWriter->stop();mainWriter.reset();}
        if(failed||!clean){try{diagnostic(pipes.error.value,reason,error);}catch(...){}}
        return !failed&&clean&&requestedStop?0:1;
    }catch(...){return 1;}
}
